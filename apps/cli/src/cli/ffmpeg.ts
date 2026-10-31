import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Sink } from '@shaderera/core'
import { fpsFraction } from '@shaderera/core/host'
import { lendTurns } from '../node/spawn-turn.ts'
import type { EncoderData, FromEncoder, ToEncoder } from './encoder.ts'

export type Quality = 'review' | 'master'

/**
 * x264 settings per delivery quality. A review is preset veryfast at crf 16: a third of medium's
 * CPU at its crf 18 quality, in a file about 20% larger (docs/delivery.md, measured on 9.0.2). A
 * master is veryfast at crf 10: slow crf 12's VMAF about 5× faster, in a file about 10% larger (#496).
 */
export const QUALITIES = {
  review: { crf: 16, preset: 'veryfast' },
  master: { crf: 10, preset: 'veryfast' },
} as const

/**
 * `x264`: libx264 on the CPU. The others are H.264 on the GPU, off the CPU the hosts render on,
 * with larger files at a like quality: a review encode, never a master unless asked (owner
 * decision, 2026-10-09). `nvenc` is NVIDIA's (measured: +13% at qp 19 against x264's review
 * on a detailed film, VMAF 99.8 to 98.6), `qsv` Intel's Quick Sync, `amf` AMD's, `videotoolbox`
 * Apple's.
 */
export type Encoder = 'x264' | Hardware
export type Hardware = 'nvenc' | 'qsv' | 'amf' | 'videotoolbox'
/** The GPU encoders, in the order a review tries them. */
export const HARDWARE: readonly Hardware[] = ['nvenc', 'qsv', 'amf', 'videotoolbox']
export const ENCODERS: readonly Encoder[] = ['x264', ...HARDWARE]
const NVENC = ['-c:v', 'h264_nvenc', '-preset', 'p5', '-tune', 'hq']
/** A GPU encoder's constant quality for a review, near x264's. */
const CQ = 19
/**
 * Each GPU encoder at a constant quality `cq` on crf's scale (VideoToolbox's -q:v runs 1-100,
 * higher better, and only Apple silicon has it). Only NVENC takes --bitrate and --maxrate.
 */
const constantQuality: Record<Hardware, (cq: number) => string[]> = {
  // A constant QP: vbr at -b:v 0 -cq n held a detailed 1080p30 film near 15 Mb/s whatever n was
  // (VMAF 63 against a lossless render, where x264's review scores 98.6); qp 19 scores 99.8 at
  // 279 Mb/s there, against x264's 246 (docs/delivery.md, measured 2026-10-27).
  nvenc: (cq) => [...NVENC, '-rc', 'constqp', '-qp', String(cq)],
  qsv: (cq) => ['-c:v', 'h264_qsv', '-preset', 'medium', '-global_quality', String(cq)],
  amf: (cq) => {
    const qp = String(cq)
    return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', qp, '-qp_p', qp]
  },
  videotoolbox: (cq) => ['-c:v', 'h264_videotoolbox', '-q:v', String(100 - 2 * cq)],
}

/**
 * Where the probe keeps what it found: one ffmpeg (its file, mtime and version) and its answers, for
 * the H.264 GPU encoders (constantQuality's settings) only. HDR10's HEVC Main 10 is asked apart
 * (hasHevcNvenc) and never kept here.
 */
export const encodersFile = (): string => join(homedir(), '.shaderera', 'encoders.json')

/** The answers encodersFile keeps for this ffmpeg (`key`); none for another or an unreadable file. */
const keptAnswers = (key: string): Record<string, boolean> => {
  try {
    const kept = JSON.parse(readFileSync(encodersFile(), 'utf8'))
    return kept.ffmpeg === key ? kept.answers : {}
  } catch {
    return {}
  }
}

const keep = (key: string, answers: Record<string, boolean>) => {
  try {
    mkdirSync(dirname(encodersFile()), { recursive: true })
    writeFileSync(encodersFile(), JSON.stringify({ ffmpeg: key, answers }))
  } catch {
    // Not kept: the next command asks again.
  }
}

/** The ffmpeg the PATH runs, as its file, its mtime and its version: what an answer is of. */
const ffmpegKey = (): string => {
  const version = requireFfmpeg()
  const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg']
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean))
    for (const name of names) {
      const file = join(dir, name)
      const stat = statSync(file, { throwIfNoEntry: false })
      if (stat?.isFile()) return `${file} ${stat.mtimeMs} ${version}`
    }
  return version
}

/** Whether ffmpeg encodes a black 0.1 s at this size with this encoder, without blocking the thread. */
const encodes = (encoder: Hardware, size: string) =>
  new Promise<boolean>((done) => {
    const args = ['-loglevel', 'error', '-f', 'lavfi', '-i', `color=black:s=${size}:d=0.1`]
    const encode = [...args, ...constantQuality[encoder](CQ), '-f', 'null', '-']
    spawn('ffmpeg', encode, { stdio: 'ignore' })
      .on('error', () => done(false))
      .on('close', (code) => done(code === 0))
  })

const answers = new Map<string, Promise<boolean>>()
/** The answers whose yes came from encodersFile, not from a test encode in this process. */
const keptYes = new Set<string>()
/**
 * Whether this ffmpeg can encode a frame this size with this GPU encoder here (a GPU and driver it
 * accepts; NVENC refuses small frames, such as 32x16). Asked once per encoder and size and kept in
 * encodersFile for this ffmpeg (a 0.25 s test encode otherwise); `fresh` asks again (doctor).
 * False without ffmpeg.
 */
export const canEncode = (
  encoder: Hardware,
  width: number,
  height: number,
  o: { fresh?: boolean } = {},
): Promise<boolean> => {
  const id = `${encoder} ${width}x${height}`
  const known = answers.get(id)
  if (known && !o.fresh) return known
  const asked = (async () => {
    let key: string
    try {
      key = ffmpegKey()
    } catch {
      return false
    }
    const kept = keptAnswers(key)[id]
    if (kept !== undefined && !o.fresh) {
      if (kept) keptYes.add(id)
      return kept
    }
    keptYes.delete(id)
    const has = await encodes(encoder, `${width}x${height}`)
    keep(key, { ...keptAnswers(key), [id]: has })
    return has
  })()
  answers.set(id, asked)
  return asked
}

/**
 * The first GPU encoder (HARDWARE's order) that encodes this size here, all asked at once;
 * undefined for none. `rated` (--bitrate or --maxrate): NVENC only.
 */
export const hardwareEncoder = async (
  width: number,
  height: number,
  o: { fresh?: boolean; rated?: boolean } = {},
): Promise<Hardware | undefined> => {
  const tried = o.rated ? (['nvenc'] as const) : HARDWARE
  const has = await Promise.all(tried.map((e) => canEncode(e, width, height, o)))
  return tried.find((_, i) => has[i])
}

/** Whether this encoder's yes at this size came from encodersFile, not a test encode here. */
export const keptEncoder = (encoder: Hardware, width: number, height: number): boolean =>
  keptYes.has(`${encoder} ${width}x${height}`)

/**
 * Drops a kept yes for this encoder and size, whose encode has just failed (a GPU or driver gone
 * since): false when the yes was not a kept one. This process then answers no; the next one tests
 * again.
 */
export const forgetEncoder = (encoder: Hardware, width: number, height: number): boolean => {
  const id = `${encoder} ${width}x${height}`
  if (!keptYes.delete(id)) return false
  answers.set(id, Promise.resolve(false))
  try {
    const key = ffmpegKey()
    const { [id]: _, ...rest } = keptAnswers(key)
    keep(key, rest)
  } catch {
    // No ffmpeg to key it by: nothing kept to drop.
  }
  return true
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

/**
 * The HDR10 tags (decision 0023): BT.2020 primaries, PQ (SMPTE ST 2084) and the BT.2020
 * non-constant-luminance matrix at narrow range, chroma sited top-left (BT.2100 Table 8; libx265
 * writes it as VUI type 2). No conversion: the frames come as PQ code values already. setparams
 * tags the frames too, since an encoder takes its colour from the frames (libx265's `hdr10-opt`
 * turns itself off on untagged ones).
 */
const PQ_TAGS = 'setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=smpte2084:range=tv'
export const HDR10 = [
  '-colorspace',
  'bt2020nc',
  '-color_primaries',
  'bt2020',
  '-color_trc',
  'smpte2084',
  '-color_range',
  'tv',
  '-chroma_sample_location',
  'topleft',
] as const

/** A number as an ffmpeg argument: 6 decimals at most, no trailing zeros. */
export const s = (n: number) => String(Number(n.toFixed(6)))

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
      // framelog=verbose keeps the line it logs every 100 ms out of stderr: past spawnSync's 1 MB
      // (a film over ten minutes) ffmpeg would be killed and the loudness lost.
      'ebur128=peak=true:framelog=verbose',
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

/**
 * ffmpeg's arguments: raw RGBA frames on stdin as input 0, and the mix's inputs and graph
 * (Mix.encode) when the file has sound. The frames reach ffmpeg matted over black (ffmpegSink), so
 * their alpha is 255.
 */
export const ffmpegArgs = (o: {
  width: number
  height: number
  fps: number
  from: number
  to: number
  out: string
  /** x264 settings: `review` is crf 16 / preset veryfast, `master` crf 10 / preset veryfast. */
  quality?: Quality
  /** Overrides the quality's crf. */
  crf?: number
  /** The mix's part of the encode (Mix.encode), or none for a file without sound. */
  audio?: { readonly inputs: readonly string[]; readonly graph: string } | null
  /**
   * What the frames are: straight RGBA (8 or 16 bits a channel; matted by ffmpegSink for a codec
   * without alpha, converted by swscale), or yuv420p the host already matted and converted on the
   * GPU (decision 0007), tagged the same.
   */
  input?: Input
  /** libx264 (the default), or a GPU's H.264 encoder (exportVideo picks one for review). */
  encoder?: Encoder
  /** `h264` (the default, mp4), or ProRes in a mov with 48 kHz 24-bit PCM. */
  codec?: Codec
  /** H.264 only: a constant bitrate (floor and ceiling at once), such as `15M`. */
  bitrate?: string
  /** H.264 only: a ceiling on the crf's bitrate, such as `10M`. */
  maxrate?: string
  /**
   * `false`: an mp4 with no edit list. Its audio must come trimmed by the AAC encoder's priming
   * (`Mix.encode(true)`) so that it still starts with the picture. Measured: an mp4 without an
   * edit list and without the trim plays its sound 21.4 ms late.
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
  // The sound runs the clip's whole length (silence after the last sound), as the WAV does.
  if (o.audio)
    args.push(...o.audio.inputs, '-filter_complex', o.audio.graph, '-map', '0:v', '-map', '[aout]')
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
    if (o.audio) args.push('-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2')
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
  const cq = o.crf === undefined ? CQ : o.crf + 1
  if (o.encoder === 'nvenc') {
    if (o.bitrate) args.push(...NVENC, '-rc', 'cbr', '-b:v', o.bitrate, ...cap(o.bitrate))
    // A constant QP takes no ceiling: --maxrate caps a vbr at cq instead.
    else if (o.maxrate)
      args.push(...NVENC, '-rc', 'vbr', '-b:v', '0', '-cq', String(cq), ...cap(o.maxrate))
    else args.push(...constantQuality.nvenc(cq))
  } else if (o.encoder && o.encoder !== 'x264') {
    if (o.bitrate || o.maxrate)
      throw new Error(`--bitrate and --maxrate are for x264 and nvenc, not ${o.encoder}.`)
    args.push(...constantQuality[o.encoder](cq))
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
  if (o.audio) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2')
  if (o.timecode) args.push('-timecode', o.timecode)
  if (o.revision) args.push(...revisionTag(o.revision))
  args.push(...muxer(o.container), '-t', s(o.to - o.from), o.out)
  return args
}

const muxer = (container?: string) => (container ? ['-f', container] : [])

/**
 * The muxer a file name's extension asks for, as ffmpeg would pick it: for a file written under
 * another name first (`<out>.<pid>.partial`, exportVideo).
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

/**
 * An SMPTE ST 2086 mastering display: the CIE 1931 xy chromaticities of its primaries and white
 * point, and its peak and minimum luminance in cd/m². The film declares it (decision 0023).
 */
export type MasteringDisplay = {
  red: readonly [number, number]
  green: readonly [number, number]
  blue: readonly [number, number]
  white: readonly [number, number]
  peak: number
  min: number
}

/** The CIE 1931 xy chromaticities of the primaries a manifest's mastering display names, D65 white. */
const PRIMARIES = {
  'p3-d65': { red: [0.68, 0.32], green: [0.265, 0.69], blue: [0.15, 0.06] },
  bt2020: { red: [0.708, 0.292], green: [0.17, 0.797], blue: [0.131, 0.046] },
  bt709: { red: [0.64, 0.33], green: [0.3, 0.6], blue: [0.15, 0.06] },
} as const
const D65 = [0.3127, 0.329] as const

/**
 * A manifest's mastering display (its `hdr10.mastering`: peak, min and the primaries' name) as ST
 * 2086 describes it: SMPTE RP 431-2's P3 primaries with D65 white, or BT.2020's or BT.709's (ITU-R
 * BT.2020 and BT.709 Table 1).
 */
export const masteringOf = (m: {
  peak: number
  min: number
  primaries: keyof typeof PRIMARIES
}): MasteringDisplay => ({ ...PRIMARIES[m.primaries], white: D65, peak: m.peak, min: m.min })

/** CTA-861.3's MaxCLL and MaxFALL in cd/m²: the brightest pixel's max(R,G,B) and the highest frame average of it. */
export type LightLevels = { maxCLL: number; maxFALL: number }

/**
 * An HDR10 encode's frames on stdin: 10-bit 4:2:0 Y'CbCr of PQ codes as P010 (the GPU's) or
 * `yuv420p10le` (an FFV1 chunk decoded) for HEVC; the hosts' 10-bit PQ R'G'B' codes (`rgb10`,
 * ffmpeg's `x2bgr10le`) for ProRes.
 */
export type HdrInput = 'p010' | 'yuv420p10le' | 'rgb10'

/**
 * `x265`: libx265, for a master always (decision 0023, as 0007 keeps x264 for SDR). `nvenc`:
 * NVIDIA's HEVC encoder, for a review (hasHevcNvenc). `videotoolbox`: Apple's, for a review only:
 * it writes neither SEI, so the file has the mp4's boxes but not the stream's metadata Apple asks for.
 */
export type HdrEncoder = 'x265' | 'nvenc' | 'videotoolbox'

/** libx265's settings per delivery quality. */
export const HEVC_QUALITIES = {
  review: { crf: 20, preset: 'medium' },
  master: { crf: 16, preset: 'slow' },
} as const

/**
 * Main 10 on the GPU. `hevc_metadata` writes the top-left chroma site into the SPS: hevc_nvenc
 * leaves `chroma_loc_info_present_flag` 0 (read with trace_headers on ffmpeg 9.0.2), which a
 * player takes as left.
 */
const HEVC_NVENC = ['-c:v', 'hevc_nvenc', '-profile:v', 'main10', '-preset', 'p5', '-tune', 'hq']
const CHROMA_TOPLEFT = ['-bsf:v', 'hevc_metadata=chroma_sample_loc_type=2']

/**
 * The display as ffmpeg's `-mastering_display` takes it: chromaticities in 0.00002, luminance in
 * 0.0001 cd/m², the units of ST 2086 and of the SEI. Primaries go green, blue, red, as HEVC orders them.
 */
export const masteringDisplayArg = (d: MasteringDisplay): string => {
  const xy = ([x, y]: readonly [number, number]) =>
    `(${Math.round(x * 50000)},${Math.round(y * 50000)})`
  return `G${xy(d.green)}B${xy(d.blue)}R${xy(d.red)}WP${xy(d.white)}L(${Math.round(d.peak * 10000)},${Math.round(d.min * 10000)})`
}

/**
 * The levels as ffmpeg's `-content_light` takes them, whole cd/m² rounded up: metadata below the
 * content would be a lie (decision 0023).
 */
export const contentLightArg = (l: LightLevels): string =>
  `${Math.ceil(l.maxCLL)},${Math.ceil(l.maxFALL)}`

const hevcNvenc = new Map<string, boolean>()
/**
 * Whether this ffmpeg can encode 10-bit HEVC with NVENC at this size here, asked once per size.
 * It writes the HDR10 SEI from side data on ffmpeg 8.0 and later (NVENC SDK 13); an HDR10 encode
 * needs 9.0 (hdr10Problem).
 */
export const hasHevcNvenc = (width: number, height: number): boolean => {
  const size = `${width}x${height}`
  if (!hevcNvenc.has(size))
    hevcNvenc.set(
      size,
      spawnSync('ffmpeg', [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=black:s=${size}:d=0.1,format=p010le`,
        ...HEVC_NVENC,
        '-f',
        'null',
        '-',
      ]).status === 0,
    )
  return hevcNvenc.get(size) === true
}

/** The release in `ffmpeg -version`'s first line (`ffmpeg version 9.0.2-full_build…`); undefined for a git build (`N-…`). */
export const ffmpegRelease = (line: string): { major: number; minor: number } | undefined => {
  const m = /^ffmpeg version n?(\d+)\.(\d+)/.exec(line)
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : undefined
}

/**
 * Why this ffmpeg cannot make HDR10, or undefined when it can: `-mastering_display` and
 * `-content_light` came in ffmpeg 9.0. A git build without a release number is asked whether it
 * has the options.
 */
export const hdr10Problem = (): string | undefined => {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
  if (r.status !== 0) return 'HDR10 needs ffmpeg 9.0 or later, and ffmpeg is not on the PATH.'
  const line = r.stdout.split(/\r?\n/)[0]?.trim() ?? ''
  const release = ffmpegRelease(line)
  const ok = release
    ? release.major >= 9
    : /-mastering_display/.test(
        spawnSync('ffmpeg', ['-hide_banner', '-h', 'full'], {
          encoding: 'utf8',
          maxBuffer: 64 * 2 ** 20,
        }).stdout ?? '',
      )
  return ok
    ? undefined
    : `HDR10 needs ffmpeg 9.0 or later (for -mastering_display and -content_light); this is ${line.replace(/ Copyright.*$/, '')}. SDR renders work on it.`
}

/** Throws hdr10Problem's line, before an HDR10 encode starts. */
export const requireHdr10Ffmpeg = () => {
  const problem = hdr10Problem()
  if (problem) throw new Error(problem)
}

/**
 * ffmpeg's arguments for an HDR10 file (decision 0023): HEVC Main 10 as `hvc1` in an mp4, or
 * ProRes 422 HQ / 4444 in a mov, tagged HDR10, with the mastering display and the light levels set
 * on the input (ffmpeg 9.0's `-mastering_display` and `-content_light`), so they reach the SEI
 * (libx265, hevc_nvenc) and the container's `mdcv` and `clli` boxes. The frames come on stdin as
 * `input`, matted over black already (ffmpegSink passes them as they are). ProRes is made by
 * ffmpeg from the `rgb10` codes with the BT.2020 matrix, so the exactness test does not cover it;
 * an HDR10 ProRes 4444 has no alpha plane (the frame is matted). The caller has checked the ffmpeg
 * (requireHdr10Ffmpeg) and, for nvenc, the GPU (hasHevcNvenc).
 */
export const hdr10Args = (o: {
  width: number
  height: number
  fps: number
  from: number
  to: number
  out: string
  input: HdrInput
  /** The declared mastering display. */
  display: MasteringDisplay
  /** The levels measured over every frame. */
  levels: LightLevels
  /** `hevc` (the default, mp4), or ProRes in a mov with 48 kHz 24-bit PCM. */
  codec?: 'hevc' | Exclude<Codec, 'h264'>
  /** HEVC only: libx265 (the default); nvenc or videotoolbox for a review. */
  encoder?: HdrEncoder
  /** libx265 settings: `review` is crf 20 / preset medium, `master` crf 16 / preset slow. */
  quality?: Quality
  /** Overrides the quality's crf (nvenc: its cq). */
  crf?: number
  audio?: { readonly inputs: readonly string[]; readonly graph: string } | null
  /** As ffmpegArgs's: `false` for an mp4 with no edit list, its audio trimmed. */
  editList?: boolean
  timecode?: string
  revision?: string
  container?: string
}): string[] => {
  const codec = o.codec ?? 'hevc'
  const encoder = o.encoder ?? 'x265'
  const prores = codec !== 'hevc'
  if (prores !== (o.input === 'rgb10'))
    throw new Error(
      prores
        ? 'HDR10 ProRes takes the 10-bit PQ R’G’B’ codes (rgb10).'
        : 'HDR10 HEVC takes 10-bit 4:2:0 frames (p010 or yuv420p10le).',
    )
  if (prores && encoder !== 'x265')
    throw new Error(`ProRes has its own encoder: ${encoder} is for HEVC.`)
  if (encoder !== 'x265' && o.quality === 'master')
    throw new Error(
      `An HDR10 master is encoded with x265: ${encoder} is for a review${encoder === 'videotoolbox' ? ' (it writes no HDR10 metadata into the stream)' : ''}.`,
    )
  const pixFmt = { p010: 'p010le', yuv420p10le: 'yuv420p10le', rgb10: 'x2bgr10le' }[o.input]
  const args = ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', pixFmt]
  args.push('-s', `${o.width}x${o.height}`, '-r', fpsFraction(o.fps))
  args.push('-mastering_display', masteringDisplayArg(o.display))
  args.push('-content_light', contentLightArg(o.levels), '-i', '-')
  if (o.audio)
    args.push(...o.audio.inputs, '-filter_complex', o.audio.graph, '-map', '0:v', '-map', '[aout]')
  if (prores) {
    const full = codec === 'prores-4444'
    const format = full ? 'yuv444p10le' : 'yuv422p10le'
    // No chroma site: ProRes is 4:2:2 or 4:4:4 and has no field for it.
    args.push(
      '-vf',
      `scale=out_color_matrix=bt2020:out_range=tv,format=${format},${PQ_TAGS}`,
      ...HDR10.slice(0, -2),
      '-c:v',
      'prores_ks',
      '-profile:v',
      full ? '4' : '3',
    )
    if (o.audio) args.push('-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2')
    if (o.timecode) args.push('-timecode', o.timecode)
    if (o.revision) args.push(...revisionTag(o.revision), '-movflags', '+use_metadata_tags')
    args.push('-fflags', '+bitexact', ...muxer(o.container), '-t', s(o.to - o.from), o.out)
    return args
  }
  args.push('-vf', PQ_TAGS, ...HDR10)
  if (encoder === 'x265') {
    const q = HEVC_QUALITIES[o.quality ?? 'review']
    args.push('-c:v', 'libx265', '-profile:v', 'main10', '-preset', q.preset)
    args.push('-crf', String(o.crf ?? q.crf))
    args.push('-x265-params', 'hdr10-opt=1:repeat-headers=1:log-level=error')
  } else if (encoder === 'nvenc')
    args.push(
      ...HEVC_NVENC,
      '-rc',
      'vbr',
      '-b:v',
      '0',
      '-cq',
      String(o.crf ?? 21),
      ...CHROMA_TOPLEFT,
    )
  else
    args.push(
      '-c:v',
      'hevc_videotoolbox',
      '-profile:v',
      'main10',
      '-q:v',
      String(o.crf ?? 65),
      ...CHROMA_TOPLEFT,
    )
  args.push('-tag:v', 'hvc1')
  const tags = o.revision ? '+use_metadata_tags' : ''
  args.push(
    '-movflags',
    `${o.editList === false ? '+faststart+negative_cts_offsets' : '+faststart'}${tags}`,
  )
  if (o.editList === false) args.push('-use_editlist', '0')
  if (o.audio) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2')
  if (o.timecode) args.push('-timecode', o.timecode)
  if (o.revision) args.push(...revisionTag(o.revision))
  args.push(...muxer(o.container), '-t', s(o.to - o.from), o.out)
  return args
}

let version: string | undefined
/**
 * Throws a clear message when ffmpeg is not on the PATH; returns its version line. Asked once a
 * process: every later call is free.
 */
export const requireFfmpeg = (): string => {
  if (version === undefined) {
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
    if (r.status !== 0)
      throw new Error(
        'render needs ffmpeg on the PATH: install it from https://ffmpeg.org/download.html',
      )
    version = r.stdout.split(/\r?\n/)[0]?.trim() ?? ''
  }
  return version
}

/**
 * An encoder ffmpeg that failed under a Sink: it exited while frames were still coming (`exit`,
 * even with 0) or read nothing for the watchdog's seconds while a frame waited (`stall`). `stderr`
 * is its last lines. Retrying the render may help (it may have run out of memory).
 */
/**
 * A line ffmpeg prints from a GPU encoder itself (tagged with its codec, as `[h264_nvenc @ …]`
 * or `[AMF @ …]`), or about opening it: what ffmpeg says when the encoder refuses (no GPU, no
 * driver, a size it does not take), as this ffmpeg said it on Windows with an NVIDIA GPU. A bad
 * option or an output that cannot be written says none of it.
 */
const ENCODER_SAID =
  /\[(?:enc:)?(?:h264|hevc)_(?:nvenc|qsv|amf|videotoolbox) @|\[AMF @|No capable devices found|OpenEncodeSessionEx|InitializeEncoder failed|Error while opening encoder|Could not open encoder/

/** Whether what ffmpeg said comes from a GPU encoder refusing (ENCODER_SAID). */
export const encoderSaid = (stderr: string): boolean => ENCODER_SAID.test(stderr)

export class FfmpegError extends Error {
  override name = 'FfmpegError'
  readonly reason: 'exit' | 'stall'
  /** Signed; null when a signal ended it, or for a stall. */
  readonly code: number | null
  readonly stderr: string
  /** A GPU encoder spoke in what ffmpeg said (encoderSaid), maybe before `stderr`'s lines. */
  readonly encoder: boolean
  constructor(
    message: string,
    reason: 'exit' | 'stall',
    code: number | null,
    stderr: string,
    encoder = encoderSaid(stderr),
  ) {
    super(stderr ? `${message}\n${stderr}` : message)
    this.reason = reason
    this.code = code
    this.stderr = stderr
    this.encoder = encoder
  }
}

/** Seconds a Sink waits for ffmpeg to read a frame before it gives up: SHADERERA_FFMPEG_STALL, 300. */
export const stallSeconds = (): number => {
  const s = Number(process.env.SHADERERA_FFMPEG_STALL)
  return Number.isFinite(s) && s > 0 ? s : 300
}

/** The last few lines of what ffmpeg said (a progress line ends in \r, not \n). */
const lastLines = (text: string, n = 5) =>
  text
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join('\n')

/**
 * Starts ffmpeg and returns a Sink that writes frames to its stdin, honouring backpressure. Its
 * stdout is ignored: it may be MCP's stream. Its stderr goes on to ours, and its tail into the
 * FfmpegError a write fails with when ffmpeg exits before `end` (a clean exit too: ffmpeg takes a
 * demuxing error, such as out of memory, as the end of its input) or stops reading for
 * `stallSeconds`; `end` fails the same way when ffmpeg has not finished within them.
 *
 * ffmpeg is fed from a thread of its own (encoder.ts), which mattes the frames and copies them into
 * the pipe; this thread only hands each frame over. With `handOver`, a frame that owns its whole
 * buffer is moved there, not copied, and reads as empty after the write: for a caller that never
 * reads a frame it wrote.
 */
export const ffmpegSink = (
  args: readonly string[],
  input: Input | HdrInput = 'rgba',
  /** `false`: the codec keeps alpha (ProRes 4444), so straight RGBA goes as it is. */
  matted = true,
  /** For tests: another program in ffmpeg's place (`command` then `args`), another watchdog. */
  o: { command?: readonly string[]; stall?: number; handOver?: boolean } = {},
): Sink => {
  const [bin = 'ffmpeg', ...pre] = o.command ?? []
  // Straight RGBA is matted over black (an mp4 has no alpha); Y'CbCr and HDR10 codes came matted.
  const { turn, transfer } = lendTurns()
  const data: EncoderData = {
    bin,
    args: [...pre, ...args],
    matte: !matted || (input !== 'rgba' && input !== 'rgba64') ? null : input,
    turn,
  }
  const encoder = new Worker(new URL(`./encoder${extname(import.meta.url)}`, import.meta.url), {
    workerData: data,
    transferList: transfer,
  })
  const tell = (m: ToEncoder, transfer?: ArrayBuffer[]) => encoder.postMessage(m, transfer)
  let said = ''
  let ending = false
  // Set once ffmpeg is gone or given up on: every write from then on fails with it.
  let failed: Error | null = null
  let pending: { done: () => void; fail: (e: Error) => void; timer: NodeJS.Timeout } | null = null
  const settle = (error: Error | null) => {
    if (!pending) return
    const p = pending
    pending = null
    clearTimeout(p.timer)
    error ? p.fail(error) : p.done()
  }
  const exited = new Promise<void>((done, fail) => {
    const gone = (error: Error) => {
      failed = error
      settle(error)
      fail(error)
    }
    encoder.on('error', gone)
    encoder.on('message', (m: FromEncoder) => {
      if (m.type === 'written') return settle(null)
      if (m.type === 'stderr') {
        const d = Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength)
        process.stderr.write(d)
        said = (said + d.toString()).slice(-4096)
        return
      }
      if (m.type === 'error') return gone(failed ?? new Error(m.message))
      // 'close', not 'exit': stderr has been read to its end, so its last lines are known.
      // Windows hands -1 back as 4294967295.
      const code = m.code === null ? null : m.code | 0
      if (code === 0 && ending && !failed) return done()
      gone(
        failed ??
          new FfmpegError(
            code === null
              ? `ffmpeg was ended by ${m.signal}.`
              : code === 0
                ? 'ffmpeg exited with 0 while frames were still coming: it stopped reading its input.'
                : `ffmpeg exited with ${code}.`,
            'exit',
            code,
            lastLines(said),
            encoderSaid(said),
          ),
      )
    })
  })
  exited.catch(() => {})
  const stall = o.stall ?? stallSeconds()
  return {
    write: (pixels) =>
      new Promise<void>((done, fail) => {
        if (failed) return fail(failed)
        const timer = setTimeout(() => {
          failed = new FfmpegError(
            `ffmpeg read nothing for ${stall} s while a frame waited: it stalled (SHADERERA_FFMPEG_STALL sets the seconds).`,
            'stall',
            null,
            lastLines(said),
          )
          settle(failed)
          tell({ type: 'kill' })
        }, stall * 1000)
        pending = { done, fail, timer }
        const view = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)
        // Moved when handed over whole; otherwise copied, only the frame's own bytes.
        const bytes =
          o.handOver === true &&
          view.byteOffset === 0 &&
          view.byteLength === view.buffer.byteLength &&
          view.buffer instanceof ArrayBuffer
            ? view
            : view.slice()
        tell({ type: 'frame', bytes }, [bytes.buffer as ArrayBuffer])
      }),
    // ffmpeg flushes and exits once its input ends; one that never does (its input's end lost)
    // fails after the watchdog's seconds, never waits for ever. Its output (the last argument)
    // written within them counts as finishing: +faststart rewrites the whole file in place then,
    // which takes minutes for a large master on a hard disk. Its mtime moves; its size does not.
    end: () =>
      new Promise<void>((done, fail) => {
        ending = true
        const written = () => statSync(args.at(-1) ?? '', { throwIfNoEntry: false })?.mtimeMs
        let last = written()
        let timer: NodeJS.Timeout
        const watch = () => {
          timer = setTimeout(() => {
            const now = written()
            if (now !== last) {
              last = now
              return watch()
            }
            failed ??= new FfmpegError(
              `ffmpeg did not finish within ${stall} s of its last frame: it stalled (SHADERERA_FFMPEG_STALL sets the seconds).`,
              'stall',
              null,
              lastLines(said),
            )
            fail(failed)
            tell({ type: 'kill' })
          }, stall * 1000)
        }
        watch()
        exited.then(done, fail).finally(() => clearTimeout(timer))
        tell({ type: 'end' })
      }),
    abort: async () => {
      ending = true
      tell({ type: 'kill' })
      await exited.catch(() => {})
    },
  }
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
    /** A PQ stream's HDR10 signalling, read back to equal what the encode declared. */
    hdr10?: Hdr10Probe
  }
  audio?: { codec: string; sampleRate: number; channels: number }
  /** Whether an mp4 or mov has an edit list (`elst`) in any track. */
  editList: boolean
  /** The revision that made the file (its `shaderera_revision` tag), when it has one. */
  revision?: string
}

/**
 * What an HDR10 file says about itself: its codec tag (`hvc1`), chroma site, the container's
 * `mdcv` and `clli` boxes (ffprobe's stream side data), and the HDR10 SEI in the first frame of
 * the stream, read apart from the boxes (seiOf). ProRes has no SEI.
 */
export type Hdr10Probe = {
  codecTag: string
  chroma?: string
  mastering?: MasteringDisplay
  light?: LightLevels
  sei?: { mastering?: MasteringDisplay; light?: LightLevels }
}

type SideData = { [key: string]: string | number | undefined }

/** A fraction as ffprobe writes it (`34000/50000`). */
const ratio = (x: unknown) => {
  const [n, d] = String(x).split('/').map(Number)
  return d ? (n as number) / d : (n as number)
}

/** The boxes, as ffprobe's stream side data gives them. */
const boxesOf = (list: readonly SideData[] = []) => {
  const md = list.find((d) => d.side_data_type === 'Mastering display metadata')
  const cl = list.find((d) => d.side_data_type === 'Content light level metadata')
  const xy = (c: string) => [ratio(md?.[`${c}_x`]), ratio(md?.[`${c}_y`])] as const
  return {
    ...(md
      ? {
          mastering: {
            red: xy('red'),
            green: xy('green'),
            blue: xy('blue'),
            white: xy('white_point'),
            peak: ratio(md.max_luminance),
            min: ratio(md.min_luminance),
          },
        }
      : {}),
    ...(cl ? { light: { maxCLL: Number(cl.max_content), maxFALL: Number(cl.max_average) } } : {}),
  }
}

/**
 * The mastering display and light level SEI in the first frame's packet of an HEVC stream, as
 * ffmpeg's `trace_headers` reads its fields: the stream's own, not the boxes ffprobe's frames
 * would inherit. The parameter sets in the `hvcC` box (traced first, as Extradata) are skipped.
 */
export const seiOf = (file: string): NonNullable<Hdr10Probe['sei']> => {
  const r = spawnSync(
    'ffmpeg',
    [
      ...['-hide_banner', '-loglevel', 'info', '-i', file, '-map', '0:v:0', '-c', 'copy'],
      ...['-frames:v', '1', '-bsf:v', 'trace_headers', '-f', 'null', '-'],
    ],
    { encoding: 'utf8' },
  )
  const lines = r.stderr.split(/\r?\n/)
  const first = lines.findIndex((l) => /\] Packet: /.test(l))
  const fields = new Map<string, number>()
  for (const l of first < 0 ? [] : lines.slice(first + 1)) {
    if (/\] Packet: /.test(l)) break
    const m = /^\[trace_headers @ [^\]]+\]\s+\d+\s+(\S+)\s+[01]+ = (\d+)$/.exec(l)
    if (m) fields.set(m[1] as string, Number(m[2]))
  }
  const f = (name: string) => fields.get(name) as number
  // HEVC orders the primaries green, blue, red.
  const xy = (i: number) =>
    [f(`display_primaries_x[${i}]`) / 50000, f(`display_primaries_y[${i}]`) / 50000] as const
  return {
    ...(fields.has('max_display_mastering_luminance')
      ? {
          mastering: {
            red: xy(2),
            green: xy(0),
            blue: xy(1),
            white: [f('white_point_x') / 50000, f('white_point_y') / 50000] as const,
            peak: f('max_display_mastering_luminance') / 10000,
            min: f('min_display_mastering_luminance') / 10000,
          },
        }
      : {}),
    ...(fields.has('max_content_light_level')
      ? {
          light: {
            maxCLL: f('max_content_light_level'),
            maxFALL: f('max_pic_average_light_level'),
          },
        }
      : {}),
  }
}

/** Probes a rendered file with ffprobe; throws when ffprobe cannot read it. */
export const probe = (file: string): Probe => {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(`ffprobe cannot read ${file}: ${r.stderr.trim()}`)
  type Stream = { [key: string]: string | number | undefined } & { side_data_list?: SideData[] }
  const j = JSON.parse(r.stdout) as { format: Stream & { tags?: Stream }; streams: Stream[] }
  const v = j.streams.find((x) => x.codec_type === 'video')
  const a = j.streams.find((x) => x.codec_type === 'audio')
  const num = (x: unknown) => (x === undefined ? undefined : Number(x))
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
            fps: ratio(v.avg_frame_rate),
            ...(v.nb_frames ? { frames: Number(v.nb_frames) } : {}),
            ...(v.bit_rate ? { bitrate: num(v.bit_rate) } : {}),
            color: {
              ...(v.color_space ? { matrix: String(v.color_space) } : {}),
              ...(v.color_primaries ? { primaries: String(v.color_primaries) } : {}),
              ...(v.color_transfer ? { transfer: String(v.color_transfer) } : {}),
              ...(v.color_range ? { range: String(v.color_range) } : {}),
            },
            ...(v.color_transfer === 'smpte2084'
              ? {
                  hdr10: {
                    codecTag: String(v.codec_tag_string),
                    ...(v.chroma_location ? { chroma: String(v.chroma_location) } : {}),
                    ...boxesOf(v.side_data_list),
                    ...(v.codec_name === 'hevc' ? { sei: seiOf(file) } : {}),
                  },
                }
              : {}),
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

/** What an HDR10 file of each codec probes as: profile, pixel format (ProRes 4444 decodes at 12 bits) and codec tag. */
const HDR10_FILES = {
  hevc: { profile: 'Main 10', pixFmt: 'yuv420p10le', tag: 'hvc1' },
  'prores-hq': { profile: 'HQ', pixFmt: 'yuv422p10le', tag: 'apch' },
  'prores-4444': { profile: '4444', pixFmt: 'yuv444p12le', tag: 'ap4h' },
} as const

/**
 * Throws unless an HDR10 file says what its encode declared (decision 0023): HEVC Main 10 as `hvc1`
 * (or ProRes 422 HQ / 4444), 10-bit narrow range, the four colour tags, and the mastering display
 * and light levels in the container's `mdcv`/`clli` boxes equal to `display` and `levels` (rounded
 * up, as `-content_light` takes them) in the units of its field. HEVC also needs the top-left
 * chroma site and the same metadata in the first frame's SEI; ProRes has neither. A VideoToolbox
 * review is the exception: `hevc_videotoolbox` writes no HDR10 SEI and no bitstream filter adds one
 * (ffmpeg 9.0's `hevc_metadata` sets VUI fields only), so its stream is held to the tags, chroma
 * site and boxes alone, and the line returned says so. A master is always held to the SEI.
 */
export const requireHdr10 = (
  file: string,
  p: Probe,
  display: MasteringDisplay,
  levels: LightLevels,
  codec: keyof typeof HDR10_FILES = 'hevc',
  encode: { encoder?: HdrEncoder; quality?: Quality } = {},
): string | undefined => {
  const v = p.video
  const h = v?.hdr10
  const units = (d?: MasteringDisplay) =>
    d
      ? [
          ...[d.red, d.green, d.blue, d.white].flatMap((xy) =>
            xy.map((c) => Math.round(c * 50000)),
          ),
          Math.round(d.peak * 10000),
          Math.round(d.min * 10000),
        ].join(',')
      : 'none'
  const light = (l?: LightLevels) => (l ? `${l.maxCLL},${l.maxFALL}` : 'none')
  const want = { display: units(display), light: contentLightArg(levels) }
  const f = HDR10_FILES[codec]
  const hevc = codec === 'hevc'
  const noSei = hevc && encode.encoder === 'videotoolbox' && encode.quality !== 'master'
  const sei = hevc && !noSei
  const wrong = [
    ...(v?.profile === f.profile ? [] : [`profile ${v?.profile ?? 'none'}, not ${f.profile}`]),
    ...(v?.pixFmt === f.pixFmt ? [] : [`${v?.pixFmt ?? 'no video'}, not ${f.pixFmt}`]),
    ...(['bt2020nc', 'bt2020', 'smpte2084', 'tv'].join() ===
    [v?.color?.matrix, v?.color?.primaries, v?.color?.transfer, v?.color?.range].join()
      ? []
      : [`colour ${JSON.stringify(v?.color ?? {})}, not bt2020nc/bt2020/smpte2084/tv`]),
    ...(h?.codecTag === f.tag ? [] : [`codec tag ${h?.codecTag ?? 'none'}, not ${f.tag}`]),
    ...(!hevc || h?.chroma === 'topleft'
      ? []
      : [`chroma site ${h?.chroma ?? 'none'}, not topleft`]),
    ...(units(h?.mastering) === want.display ? [] : [`mdcv ${units(h?.mastering)}`]),
    ...(light(h?.light) === want.light ? [] : [`clli ${light(h?.light)}`]),
    ...(!sei || units(h?.sei?.mastering) === want.display
      ? []
      : [`SEI display ${units(h?.sei?.mastering)}`]),
    ...(!sei || light(h?.sei?.light) === want.light ? [] : [`SEI light ${light(h?.sei?.light)}`]),
  ]
  if (wrong.length > 0)
    throw new Error(
      `${file} is not the HDR10 file its encode declared (display ${want.display}, light ${want.light}): ${wrong.join('; ')}.`,
    )
  return noSei
    ? `${file} has the HDR10 tags and the mp4's mdcv/clli boxes but no HDR10 SEI in the stream (hevc_videotoolbox writes none): a review, not a master.`
    : undefined
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
    ...(p.video?.hdr10
      ? [
          `HDR10 ${p.video.hdr10.codecTag}${p.video.hdr10.light ? `, MaxCLL ${p.video.hdr10.light.maxCLL} / MaxFALL ${p.video.hdr10.light.maxFALL} cd/m²` : ''}`,
        ]
      : []),
    p.audio
      ? `${p.audio.codec} ${p.audio.sampleRate / 1000} kHz ${p.audio.channels} ch`
      : 'no audio',
    p.editList ? 'edit list' : 'no edit list',
    ...(p.revision ? [`revision ${p.revision.slice(0, 12)}`] : []),
  ].join(', ')
