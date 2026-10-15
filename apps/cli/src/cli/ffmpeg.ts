import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import type { Pcm, SampledClip, Sink } from '@shaderera/core'
import { fpsFraction, gainAt, matte } from '@shaderera/core/host'

/**
 * An audio clip with its file as an absolute path, and for a gain that changes over time the
 * envelope of the export window (`gainFile`: 48 kHz mono 32-bit float, from `withGainFiles`).
 */
export type Clip = SampledClip & { readonly file: string; readonly gainFile?: string }

const RATE = 48000

/**
 * Writes the envelope of each clip whose gain changes over time, for the window [from, to] at
 * 48 kHz (interpolated between the host's samples), so ffmpeg multiplies it in sample by sample.
 * `cleanup` removes the files.
 */
export const withGainFiles = (
  clips: readonly Clip[],
  from: number,
  to: number,
): { clips: Clip[]; cleanup: () => void } => {
  if (!clips.some((c) => typeof c.gain === 'object'))
    return { clips: [...clips], cleanup: () => {} }
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-gain-'))
  const out = clips.map((c, i) => {
    if (typeof c.gain !== 'object') return c
    const n = Math.max(1, Math.ceil((to - from) * RATE))
    const env = new Float32Array(n)
    for (let k = 0; k < n; k++) env[k] = gainAt(c.gain, from + k / RATE)
    const gainFile = join(dir, `${i}.f32`)
    writeFileSync(gainFile, new Uint8Array(env.buffer))
    return { ...c, gainFile }
  })
  return { clips: out, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** ffmpeg inputs for the clips' envelopes, after the clips' own (audioMix numbers them so). */
const gainInputs = (clips: readonly Clip[]): string[] =>
  clips.flatMap((c) =>
    c.gainFile ? ['-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', c.gainFile] : [],
  )

export type Quality = 'review' | 'master'

/** x264 settings per delivery quality. */
export const QUALITIES = {
  review: { crf: 18, preset: 'medium' },
  master: { crf: 12, preset: 'slow' },
} as const

/**
 * `x264`: libx264 on the CPU. `nvenc`: NVIDIA's H.264 encoder on the GPU, about 2.5× faster and
 * off the CPU the hosts render on, with larger files at a like quality (measured: +48% at cq 19
 * against crf 18): a review encode, never a master (owner decision, 2026-10-09).
 */
export type Encoder = 'x264' | 'nvenc'
const NVENC = ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-b:v', '0']
/** NVENC's constant quality for a review, near x264's crf 18. */
const NVENC_CQ = 19

const nvenc = new Map<string, boolean>()
/**
 * Whether this ffmpeg can encode a frame this size with NVENC here (a GPU and driver it accepts;
 * NVENC refuses small frames, such as 32×16), asked once per size.
 */
export const hasNvenc = (width: number, height: number): boolean => {
  const size = `${width}x${height}`
  if (!nvenc.has(size))
    nvenc.set(
      size,
      spawnSync('ffmpeg', [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=black:s=${size}:d=0.1`,
        ...NVENC,
        '-f',
        'null',
        '-',
      ]).status === 0,
    )
  return nvenc.get(size) === true
}

/**
 * The tested SDR conversion: sRGB-encoded RGBA to 4:2:0 Y'CbCr with the BT.709 matrix at limited
 * range, tagged BT.709 primaries, transfer and matrix, so a player decodes with the matrix the
 * pixels were encoded with. sRGB's primaries are BT.709's. No transfer conversion is made: the
 * sRGB code values are carried unchanged and the BT.709 transfer tag is a delivery policy (the
 * SDR video convention), not a conversion. docs/delivery.md says which players were measured.
 */
const TAGS = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'
export const SDR_BT709 = [
  '-vf',
  'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,' + TAGS,
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'bt709',
  '-color_range',
  'tv',
] as const

const s = (n: number) => String(Number(n.toFixed(6)))

/**
 * The clips as one filter graph ending in `[aout]`: each trimmed to the export window (starting at
 * `from`), delayed to its place, given its gain and mixed without amix's default scaling. Clip i is
 * input `first + i`; the envelopes of clips whose gain changes over time follow the clips, in order.
 */
export const audioMix = (clips: readonly Clip[], from: number, first: number): string => {
  let envelope = first + clips.length
  const chains = clips.map((c, i) => {
    const start = (c.from ?? 0) + Math.max(0, from - c.at)
    const end = c.to === undefined ? '' : `:end=${s(c.to)}`
    const delay = Math.round(Math.max(0, c.at - from) * 1000)
    const placed = `[${i + first}:a]atrim=start=${s(start)}${end},asetpts=PTS-STARTPTS,adelay=${delay}:all=1`
    if (!c.gainFile) return `${placed},volume=${typeof c.gain === 'number' ? c.gain : 1}[a${i}]`
    // Both on the window's timeline from 0, multiplied sample by sample.
    const stereo = `aformat=sample_fmts=flt:sample_rates=${RATE}:channel_layouts=stereo`
    return [
      `${placed},aresample=${RATE},${stereo}[c${i}]`,
      `[${envelope++}:a]pan=stereo|c0=c0|c1=c0,${stereo}[e${i}]`,
      `[c${i}][e${i}]amultiply[a${i}]`,
    ].join(';')
  })
  const inputs = clips.map((_, i) => `[a${i}]`).join('')
  return [
    ...chains,
    `${inputs}amix=inputs=${clips.length}:normalize=0:duration=longest[aout]`,
  ].join(';')
}

/**
 * The end of the mix: an optional constant gain in dB (a requested loudness), an optional cut of
 * `trim` samples at 48 kHz from the start (an mp4 without an edit list), then padding, in frames of
 * 1024 samples so PCM packets do not follow the timing of the pipe (the same mix, the same file).
 */
const tail = (gainDb?: number, trim = 0) =>
  `;[mix]${gainDb === undefined ? '' : `volume=${s(gainDb)}dB,`}${
    trim > 0 ? `aresample=${RATE},atrim=start_sample=${trim},asetpts=PTS-STARTPTS,` : ''
  }apad,asetnsamples=n=1024:p=0[aout]`

/** The samples ffmpeg's AAC encoder primes with, which an mp4's edit list skips: 21.3 ms. */
export const PRIMING = 1024

/** `h264` in an mp4; ProRes 422 HQ, or ProRes 4444 with its alpha, in a mov. */
export type Codec = 'h264' | 'prores-hq' | 'prores-4444'
export const CODECS: readonly Codec[] = ['h264', 'prores-hq', 'prores-4444']

/** The frames ffmpeg reads: straight RGBA at 8 or 16 bits a channel, or yuv420p from the GPU. */
export type Input = 'rgba' | 'rgba64' | 'yuv420p'

/** Loudness by EBU R128 (ITU-R BS.1770): integrated, range and true peak. */
export type Loudness = { integrated: number; range: number; truePeak: number }

/**
 * The loudness of a file's audio, measured by ffmpeg's ebur128 filter; null when it has no audio
 * or ffmpeg cannot read it. Silence measures -70 LUFS, ebur128's floor.
 */
export const measureLoudness = (file: string): Loudness | null => {
  const r = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-af',
      'ebur128=peak=true',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  )
  if (r.status !== 0) return null
  const summary = r.stderr.slice(r.stderr.lastIndexOf('Summary:'))
  const value = (label: string) => {
    const m = new RegExp(`${label}:\\s+(-?[\\d.]+|-inf)`).exec(summary)
    return m ? (m[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(m[1])) : Number.NaN
  }
  const loudness = { integrated: value('I'), range: value('LRA'), truePeak: value('Peak') }
  return Object.values(loudness).some(Number.isNaN) ? null : loudness
}

/** Loudness as one line: `-23.0 LUFS, true peak -1.2 dBTP, range 5.2 LU`. */
export const loudnessLine = (l: Loudness) =>
  `${l.integrated.toFixed(1)} LUFS, true peak ${l.truePeak.toFixed(1)} dBTP, range ${l.range.toFixed(1)} LU`

/** The loudness of the clips' mix over [from, to], from a temporary WAV; null without clips. */
export const mixLoudness = (clips: readonly Clip[], from: number, to: number): Loudness | null => {
  if (clips.length === 0) return null
  const dir = mkdtempSync(join(tmpdir(), 'shaderera-loudness-'))
  const gains = withGainFiles(clips, from, to)
  try {
    const out = join(dir, 'mix.wav')
    const r = spawnSync('ffmpeg', wavArgs({ from, to, out, clips: gains.clips }), {
      encoding: 'utf8',
    })
    if (r.status !== 0) throw new Error(`ffmpeg (audio) failed: ${r.stderr}`)
    return measureLoudness(out)
  } finally {
    gains.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The constant gain, in dB, that brings the mix to `target` LUFS integrated: linear, with no
 * compression or limiting, so the mix keeps its shape (decision 0011). The true peak moves by the
 * same dB and is reported, never limited. Null for a mix too quiet to measure (-70 LUFS or below).
 */
export const loudnessGain = (
  clips: readonly Clip[],
  from: number,
  to: number,
  target: number,
): { gainDb: number; before: Loudness } | null => {
  const before = mixLoudness(clips, from, to)
  if (!before || before.integrated <= -70) return null
  return { gainDb: target - before.integrated, before }
}

/**
 * The finishing handoff's audio: the same mix as the mp4's, as 48 kHz 24-bit stereo PCM WAV,
 * padded or cut to exactly the window's length. `gainDb`: a constant gain after the mix.
 */
export const wavArgs = (o: {
  from: number
  to: number
  out: string
  clips: readonly Clip[]
  gainDb?: number
}) => {
  const args = ['-y', '-loglevel', 'error']
  for (const c of o.clips) args.push('-i', c.file)
  args.push(...gainInputs(o.clips))
  const graph = `${audioMix(o.clips, o.from, 0).replace('[aout]', '[mix]')}${tail(o.gainDb)}`
  args.push('-filter_complex', graph, '-map', '[aout]')
  args.push('-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', '-t', s(o.to - o.from), o.out)
  return args
}

/**
 * ffmpeg's arguments: raw RGBA frames on stdin, each clip trimmed to the export window, delayed
 * to its place and mixed without amix's default scaling. The frames reach ffmpeg matted over
 * black (ffmpegSink), so their alpha is 255.
 */
export const ffmpegArgs = (o: {
  width: number
  height: number
  fps: number
  from: number
  to: number
  out: string
  /** x264 settings: `review` is crf 18 / preset medium, `master` crf 12 / preset slow. */
  quality?: Quality
  /** Overrides the quality's crf. */
  crf?: number
  clips: readonly Clip[]
  /**
   * What the frames are: straight RGBA (8 or 16 bits a channel; matted by ffmpegSink for a codec
   * without alpha, converted by swscale), or yuv420p the host already matted and converted on the
   * GPU (decision 0007), tagged the same.
   */
  input?: Input
  /** libx264 (the default), or the GPU's H.264 encoder (exportVideo picks it for review). */
  encoder?: Encoder
  /** A constant gain after the mix, in dB (a requested loudness: loudnessGain). */
  gainDb?: number
  /** `h264` (the default, mp4), or ProRes in a mov with 48 kHz 24-bit PCM. */
  codec?: Codec
  /** H.264 only: a constant bitrate (floor and ceiling at once), such as `15M`. */
  bitrate?: string
  /** H.264 only: a ceiling on the crf's bitrate, such as `10M`. */
  maxrate?: string
  /**
   * `false`: an mp4 with no edit list, its audio trimmed by the AAC encoder's priming so that it
   * still starts with the picture (the first 21.3 ms of the mix are dropped). Measured: an mp4
   * without an edit list and without the trim plays its sound 21.4 ms late.
   */
  editList?: boolean
  /** The timecode of the file's first frame, written as the container's timecode. */
  timecode?: string
  /** The revision that made the file, written as its `shaderera_revision` tag. */
  revision?: string
  /** The muxer (`-f`), when `out`'s own name does not say it: containerOf. */
  container?: string
}): string[] => {
  const codec = o.codec ?? 'h264'
  const prores = codec !== 'h264'
  if (prores && (o.bitrate || o.maxrate))
    throw new Error('ProRes has its own data rate: --bitrate and --maxrate are for H.264.')
  if (prores && o.input === 'yuv420p') throw new Error('ProRes takes RGBA frames, not yuv420p.')
  const q = QUALITIES[o.quality ?? 'review']
  const yuv = o.input === 'yuv420p'
  const pixFmt = { rgba: 'rgba', rgba64: 'rgba64le', yuv420p: 'yuv420p' }[o.input ?? 'rgba']
  const args = ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', pixFmt]
  args.push('-s', `${o.width}x${o.height}`, '-r', fpsFraction(o.fps), '-i', '-')
  for (const c of o.clips) args.push('-i', c.file)
  args.push(...gainInputs(o.clips))
  // AAC's priming (1024 samples), cut from the mix when the mp4 has no edit list to skip it.
  const trim = !prores && o.editList === false ? PRIMING : 0
  // The sound runs the clip's whole length (silence after the last sound), as the WAV does.
  if (o.clips.length > 0)
    args.push(
      '-filter_complex',
      `${audioMix(o.clips, o.from, 1).replace('[aout]', '[mix]')}${tail(o.gainDb, trim)}`,
      '-map',
      '0:v',
      '-map',
      '[aout]',
    )
  if (prores) {
    const alpha = codec === 'prores-4444'
    const format = alpha ? 'yuva444p10le' : 'yuv422p10le'
    args.push(
      '-vf',
      `scale=out_color_matrix=bt709:out_range=tv,format=${format},${TAGS}`,
      ...SDR_BT709.slice(2),
      '-c:v',
      'prores_ks',
      '-profile:v',
      alpha ? '4' : '3',
      ...(alpha ? ['-alpha_bits', '16'] : []),
    )
    if (o.clips.length > 0) args.push('-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2')
    if (o.timecode) args.push('-timecode', o.timecode)
    if (o.revision) args.push(...revisionTag(o.revision), '-movflags', '+use_metadata_tags')
    // The mov muxer stamps the time of writing: bitexact leaves it out, so the same frames give
    // the same file.
    args.push('-fflags', '+bitexact', ...muxer(o.container), '-t', s(o.to - o.from), o.out)
    return args
  }
  const sdr: readonly string[] = yuv ? ['-vf', TAGS, ...SDR_BT709.slice(2)] : SDR_BT709
  args.push(...sdr)
  const cap = (rate: string) => ['-maxrate', rate, '-bufsize', doubled(rate)]
  if (o.encoder === 'nvenc') {
    if (o.bitrate)
      args.push(...NVENC.slice(0, 6), '-rc', 'cbr', '-b:v', o.bitrate, ...cap(o.bitrate))
    else {
      args.push(...NVENC, '-cq', String(o.crf === undefined ? NVENC_CQ : o.crf + 1))
      if (o.maxrate) args.push(...cap(o.maxrate))
    }
  } else {
    args.push('-c:v', 'libx264', '-preset', q.preset)
    if (o.bitrate)
      // Constant bitrate with filler (HRD): the floor holds even on a still frame.
      args.push(
        '-b:v',
        o.bitrate,
        '-minrate',
        o.bitrate,
        '-maxrate',
        o.bitrate,
        '-bufsize',
        o.bitrate,
        '-x264-params',
        'nal-hrd=cbr:force-cfr=1',
      )
    else {
      args.push('-crf', String(o.crf ?? q.crf))
      if (o.maxrate) args.push(...cap(o.maxrate))
    }
  }
  // Without an edit list, B-frames' reordering would start the picture two frames late: negative
  // composition offsets keep its first frame at 0 instead (measured with -ignore_editlist).
  const tags = o.revision ? '+use_metadata_tags' : ''
  args.push(
    '-movflags',
    `${o.editList === false ? '+faststart+negative_cts_offsets' : '+faststart'}${tags}`,
  )
  if (o.editList === false) args.push('-use_editlist', '0')
  // 48 kHz stereo, as YouTube asks and the WAV handoff is (an mp4 otherwise keeps the files' rate).
  if (o.clips.length > 0) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2')
  if (o.timecode) args.push('-timecode', o.timecode)
  if (o.revision) args.push(...revisionTag(o.revision))
  args.push(...muxer(o.container), '-t', s(o.to - o.from), o.out)
  return args
}

const muxer = (container?: string) => (container ? ['-f', container] : [])

/**
 * The muxer a file name's extension asks for, as ffmpeg would pick it: for a file written under
 * another name first (`<out>.partial`, exportVideo).
 */
export const containerOf = (file: string, codec: Codec = 'h264'): string => {
  const ext = extname(file).toLowerCase()
  if (ext === '.mov') return 'mov'
  if (ext === '.mkv') return 'matroska'
  if (ext === '.mp4' || ext === '.m4v') return 'mp4'
  return codec === 'h264' ? 'mp4' : 'mov'
}

/** The tag that names a file's revision, so a file found later leads back to its source. */
const revisionTag = (id: string) => ['-metadata', `shaderera_revision=${id}`]

/** A rate such as `15M`, `800k` or `2500000` in bits a second; throws on anything else. */
export const bitsPerSecond = (rate: string): number => {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(rate.trim())
  if (!m) throw new Error(`A bitrate is a number with k or M, such as 15M or 800k: ${rate}`)
  return Number(m[1]) * ({ k: 1e3, m: 1e6 }[(m[2] ?? '').toLowerCase()] ?? 1)
}
const doubled = (rate: string) => String(Math.round(bitsPerSecond(rate) * 2))

/** Throws a clear message when ffmpeg is not on the PATH. */
export const requireFfmpeg = () => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) {
    throw new Error(
      'render needs ffmpeg on the PATH: install it from https://ffmpeg.org/download.html',
    )
  }
}

/**
 * Starts ffmpeg and returns a Sink that writes frames to its stdin, honouring backpressure. Its
 * stdout is ignored: it may be MCP's stream.
 */
export const ffmpegSink = (
  args: readonly string[],
  input: Input = 'rgba',
  /** `false`: the codec keeps alpha (ProRes 4444), so straight RGBA goes as it is. */
  matted = true,
): Sink => {
  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'inherit'] })
  const exited = new Promise<void>((done, fail) => {
    ff.once('error', fail)
    ff.once('exit', (code) =>
      code === 0 ? done() : fail(new Error(`ffmpeg exited with ${code}.`)),
    )
  })
  exited.catch(() => {})
  // An ffmpeg that exits early closes the pipe: the write fails with EPIPE, and `exited` says why.
  ff.stdin.on('error', () => {})
  return {
    // Straight RGBA is matted over black here (an mp4 has no alpha); yuv420p came matted.
    write: (pixels) =>
      new Promise<void>((done, fail) => {
        const bytes =
          !matted || input === 'yuv420p'
            ? pixels
            : input === 'rgba'
              ? matte(pixels)
              : matte64(pixels)
        if (ff.stdin.write(bytes)) return done()
        ff.stdin.once('drain', done)
        exited.catch(fail)
      }),
    end: async () => {
      ff.stdin.end()
      await exited
    },
    abort: async () => {
      ff.kill()
      await exited.catch(() => {})
    },
  }
}

/** `matte` at 16 bits a channel: straight little-endian RGBA over black, alpha made opaque. */
export const matte64 = (data: Uint8Array | Uint8ClampedArray): Uint8Array => {
  const src = new Uint16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.length))
  const out = new Uint16Array(src.length)
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3] as number
    for (let c = i; c < i + 3; c++) out[c] = Math.round(((src[c] as number) * a) / 65535)
    out[i + 3] = 65535
  }
  return new Uint8Array(out.buffer)
}

/** The clips by `group` (clips without one are `ungrouped`), in the order groups first appear. */
export const stemsOf = (clips: readonly Clip[]): Map<string, Clip[]> => {
  const groups = new Map<string, Clip[]>()
  for (const c of clips) {
    const name = c.group ?? 'ungrouped'
    if (!/^[\w.-]+$/.test(name))
      throw new Error(`A clip's group names a stem file: letters, digits, . _ - (${name}).`)
    groups.set(name, [...(groups.get(name) ?? []), c])
  }
  return groups
}

/**
 * Writes one WAV per group into `dir` (`<group>.wav`), each the mix of that group's clips with the
 * same gains and the same constant gain as the full mix, so the stems sum to it. Returns the files.
 */
export const writeStems = (o: {
  clips: readonly Clip[]
  from: number
  to: number
  dir: string
  gainDb?: number
}): string[] => {
  mkdirSync(o.dir, { recursive: true })
  return [...stemsOf(o.clips)].map(([name, clips]) => {
    const out = join(o.dir, `${name}.wav`)
    const r = spawnSync('ffmpeg', wavArgs({ ...o, clips, out }), { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`ffmpeg (stem ${name}) failed: ${r.stderr}`)
    return out
  })
}

/** What ffprobe and the file's boxes say about an output: what a placement is checked against. */
export type Probe = {
  container: string
  bytes: number
  duration: number
  /** Bits a second over the whole file. */
  bitrate: number
  video?: {
    codec: string
    profile?: string
    pixFmt: string
    width: number
    height: number
    fps: number
    /** Frames in the file, from its index (`nb_frames`); absent when the container has none. */
    frames?: number
    bitrate?: number
    color?: { matrix?: string; primaries?: string; transfer?: string; range?: string }
  }
  audio?: { codec: string; sampleRate: number; channels: number }
  /** Whether an mp4 or mov has an edit list (`elst`) in any track. */
  editList: boolean
  /** The revision that made the file (its `shaderera_revision` tag), when it has one. */
  revision?: string
}

/** Probes a rendered file with ffprobe; throws when ffprobe cannot read it. */
export const probe = (file: string): Probe => {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(`ffprobe cannot read ${file}: ${r.stderr.trim()}`)
  type Stream = { [key: string]: string | number | undefined }
  const j = JSON.parse(r.stdout) as { format: Stream & { tags?: Stream }; streams: Stream[] }
  const v = j.streams.find((x) => x.codec_type === 'video')
  const a = j.streams.find((x) => x.codec_type === 'audio')
  const num = (x: unknown) => (x === undefined ? undefined : Number(x))
  const rate = (x: unknown) => {
    const [n, d] = String(x).split('/').map(Number)
    return d ? (n as number) / d : (n as number)
  }
  return {
    container: String(j.format.format_name),
    bytes: Number(j.format.size),
    duration: Number(j.format.duration),
    bitrate: Number(j.format.bit_rate),
    ...(v
      ? {
          video: {
            codec: String(v.codec_name),
            ...(v.profile ? { profile: String(v.profile) } : {}),
            pixFmt: String(v.pix_fmt),
            width: Number(v.width),
            height: Number(v.height),
            fps: rate(v.avg_frame_rate),
            ...(v.nb_frames ? { frames: Number(v.nb_frames) } : {}),
            ...(v.bit_rate ? { bitrate: num(v.bit_rate) } : {}),
            color: {
              ...(v.color_space ? { matrix: String(v.color_space) } : {}),
              ...(v.color_primaries ? { primaries: String(v.color_primaries) } : {}),
              ...(v.color_transfer ? { transfer: String(v.color_transfer) } : {}),
              ...(v.color_range ? { range: String(v.color_range) } : {}),
            },
          },
        }
      : {}),
    ...(a
      ? {
          audio: {
            codec: String(a.codec_name),
            sampleRate: Number(a.sample_rate),
            channels: Number(a.channels),
          },
        }
      : {}),
    editList: hasEditList(file),
    ...(j.format.tags?.shaderera_revision
      ? { revision: String(j.format.tags.shaderera_revision) }
      : {}),
  }
}

/**
 * Throws when the file holds fewer (or more) frames than were written to ffmpeg. ffmpeg can stop
 * reading its input on an error ("Error during demuxing: Cannot allocate memory"), finish the file
 * with what it has and exit 0: its exit code alone would pass a short film.
 */
export const requireFrames = (file: string, p: Probe, written: number) => {
  const frames = p.video?.frames
  if (frames !== undefined && frames !== written)
    throw new Error(
      `ffmpeg wrote ${frames} of the ${written} frames it was given to ${file} and exited 0: the file is not the film (ffmpeg's own error is above; it may have run out of memory). Render again.`,
    )
}

/**
 * Whether an ISO media file (mp4, mov) has an `elst` box under moov/trak/edts. Only box headers
 * are read, so the frames (`mdat`, gigabytes in a master) are skipped, not loaded.
 */
export const hasEditList = (file: string): boolean => {
  const fd = openSync(file, 'r')
  const head = Buffer.alloc(16)
  const CONTAINERS = new Set(['moov', 'trak', 'edts'])
  const walk = (from: number, to: number): boolean => {
    let at = from
    while (at + 8 <= to) {
      readSync(fd, head, 0, 16, at)
      let size = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      let length = 8
      if (size === 1) {
        size = Number(head.readBigUInt64BE(8))
        length = 16
      } else if (size === 0) size = to - at
      if (size < length) return false
      if (type === 'elst') return true
      if (CONTAINERS.has(type) && walk(at + length, Math.min(to, at + size))) return true
      at += size
    }
    return false
  }
  try {
    return walk(0, fstatSync(fd).size)
  } finally {
    closeSync(fd)
  }
}

/** A probed file as one line: `h264 High yuv420p 1920×1080 60 fps, 12.31 Mb/s, aac 48 kHz 2 ch, edit list`. */
export const probeLine = (p: Probe): string =>
  [
    p.video
      ? `${p.video.codec}${p.video.profile ? ` ${p.video.profile}` : ''} ${p.video.pixFmt} ${p.video.width}×${p.video.height} ${Number(p.video.fps.toFixed(3))} fps, ${(p.bitrate / 1e6).toFixed(2)} Mb/s`
      : 'no video',
    p.audio
      ? `${p.audio.codec} ${p.audio.sampleRate / 1000} kHz ${p.audio.channels} ch`
      : 'no audio',
    p.editList ? 'edit list' : 'no edit list',
    ...(p.revision ? [`revision ${p.revision.slice(0, 12)}`] : []),
  ].join(', ')

/** A WAV of 32-bit float samples, channels interleaved. */
export const floatWav = (pcm: Pcm): Uint8Array => {
  const channels = pcm.channels.length
  const frames = pcm.channels[0]?.length ?? 0
  if (channels < 1 || channels > 2 || pcm.channels.some((c) => c.length !== frames))
    throw new Error('A pcm clip has one or two channels of the same length.')
  if (!(Number.isInteger(pcm.sampleRate) && pcm.sampleRate > 0))
    throw new Error(
      `A pcm clip's sampleRate is a whole number of samples a second, not ${pcm.sampleRate}.`,
    )
  const data = frames * channels * 4
  const out = Buffer.alloc(44 + data)
  out.write('RIFF', 0, 'latin1')
  out.writeUInt32LE(36 + data, 4)
  out.write('WAVEfmt ', 8, 'latin1')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(3, 20) // IEEE float
  out.writeUInt16LE(channels, 22)
  out.writeUInt32LE(pcm.sampleRate, 24)
  out.writeUInt32LE(pcm.sampleRate * channels * 4, 28)
  out.writeUInt16LE(channels * 4, 32)
  out.writeUInt16LE(32, 34)
  out.write('data', 36, 'latin1')
  out.writeUInt32LE(data, 40)
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++)
      out.writeFloatLE((pcm.channels[c] as Float32Array)[i] as number, 44 + (i * channels + c) * 4)
  return out
}

/**
 * The clips with a file for each: a project file (`src`), or a temporary float WAV for sound made
 * in code (`pcm`). `cleanup` removes the temporary files.
 */
export const clipFiles = (
  root: string,
  clips: readonly SampledClip[],
): { clips: Clip[]; cleanup: () => void } => {
  let dir: string | undefined
  const out = clips.map((c, i): Clip => {
    if (c.src !== undefined && c.pcm === undefined) return { ...c, file: resolve(root, c.src) }
    if (c.pcm === undefined || c.src !== undefined)
      throw new Error(
        `Audio clip ${i} needs a src (a project file) or pcm (samples), and only one.`,
      )
    dir ??= mkdtempSync(join(tmpdir(), 'shaderera-pcm-'))
    const file = join(dir, `${i}.wav`)
    writeFileSync(file, floatWav(c.pcm))
    return { ...c, file }
  })
  return { clips: out, cleanup: () => dir && rmSync(dir, { recursive: true, force: true }) }
}
