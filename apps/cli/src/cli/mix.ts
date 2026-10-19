// A film's mix (GLOSSARY: Mix, Stem): its audio clips inside a job's window, each trimmed, delayed
// into place and scaled by its gain, then summed without normalisation. render, finishing and
// review each open it once; it owns probing, gain envelopes, temporary files and their removal.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { GainCurve, Pcm, SampledClip } from '@shaderera/core'
import { gainAt } from '@shaderera/core/host'
import { type Loudness, measureLoudness } from './ffmpeg.ts'

/** The stretch of the composition the mix covers, in seconds: the file's start and end. */
export type Window = { readonly from: number; readonly to: number }

/**
 * The mix's part of a video encode whose input 0 is the frames: its ffmpeg inputs (the clips',
 * then the envelopes'), and a filter graph ending in `[aout]`.
 */
export type EncodeAudio = { readonly inputs: readonly string[]; readonly graph: string }

export type Mix = {
  /** The clips heard, as listed: a src with no audio stream is silence and is not among them. */
  readonly clips: readonly SampledClip[]
  /**
   * The constant gain a loudness target applied, in dB, and the mix measured before it. Absent
   * without a target, or for a mix too quiet to measure (-70 LUFS or below).
   */
  readonly level?: { readonly gainDb: number; readonly before: Loudness }
  /**
   * The audio of a video encode; null when nothing is heard. `trim`: cut the AAC encoder's priming
   * from the start, for an mp4 without an edit list (decision 0012).
   */
  encode(trim?: boolean): EncodeAudio | null
  /** Writes the mix to `out` as 48 kHz 24-bit stereo PCM WAV, padded or cut to the window. */
  wav(out: string): void
  /**
   * Writes one WAV per group into `dir` (`<group>.wav`, clips without one `ungrouped`), with the
   * same gains and the same constant gain as the mix, so the stems sum to it. Returns the files.
   */
  stems(dir: string): string[]
  /** Removes the mix's temporary files. */
  close(): void
}

/**
 * Opens the mix of `clips` (paths relative to `root`) over `window`. Every src is probed first: a
 * src that cannot be read throws, naming the clip. With `loudness`, it measures the mix and works
 * out the one constant gain that brings it to that many LUFS integrated, never limited (decision
 * 0011). On a throw, the temporary files it wrote are removed; otherwise `close` removes them.
 */
export const openMix = (
  root: string,
  clips: readonly SampledClip[],
  window: Window,
  options: { loudness?: number } = {},
): Mix => {
  const files = clipFiles(root, clips)
  let dir: string | undefined
  const temp = () => {
    dir ??= mkdtempSync(join(tmpdir(), 'shaderera-mix-'))
    return dir
  }
  const close = () => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
  try {
    const heard = files.map((c, i): Clip => {
      const file = c.pcm ? join(temp(), `${c.index}.wav`) : c.file
      if (c.pcm) writeFileSync(file, pcmWav(c.pcm, c.name))
      const gainFile =
        typeof c.gain === 'object' ? envelope(c.gain, window, join(temp(), `${i}.f32`)) : undefined
      return { ...c, file, ...(gainFile ? { gainFile } : {}) }
    })
    const write = (out: string, part: readonly Clip[], gainDb?: number) => {
      const r = spawnSync('ffmpeg', wavArgs(part, window, out, gainDb), { encoding: 'utf8' })
      if (r.status !== 0)
        throw new Error(
          `ffmpeg could not mix ${part.map((c) => c.name).join(', ')}: ${(r.error?.message ?? r.stderr).trim()}`,
        )
    }
    let level: Mix['level']
    if (options.loudness !== undefined && heard.length > 0) {
      const measured = join(temp(), 'loudness.wav')
      write(measured, heard)
      const before = measureLoudness(measured)
      if (before && before.integrated > -70)
        level = { gainDb: options.loudness - before.integrated, before }
    }
    return {
      clips: heard,
      ...(level ? { level } : {}),
      encode: (trim = false) =>
        heard.length === 0
          ? null
          : {
              inputs: inputs(heard),
              graph: `${graph(heard, window.from, 1)}${tail(level?.gainDb, trim ? PRIMING : 0)}`,
            },
      wav: (out) => write(out, heard, level?.gainDb),
      stems: (into) => {
        mkdirSync(into, { recursive: true })
        return [...stemsOf(heard)].map(([name, part]) => {
          const out = join(into, `${name}.wav`)
          write(out, part, level?.gainDb)
          return out
        })
      },
      close,
    }
  } catch (error) {
    close()
    throw error
  }
}

/**
 * The mix as a WAV at `out`, with its stems in `stems` and its loudness measured on the WAV;
 * without `out`, only measured. Nothing is written when nothing is heard. Opens the mix and
 * closes it, so its temporary files are removed even on a throw.
 */
export const mixWav = (
  root: string,
  clips: readonly SampledClip[],
  window: Window,
  options: { out?: string; stems?: string; loudness?: number } = {},
): {
  clips: readonly SampledClip[]
  loudness: Loudness | null
  gainDb?: number
  stems?: string[]
} => {
  const mix = openMix(root, clips, window, options)
  try {
    if (mix.clips.length === 0) return { clips: [], loudness: null }
    const stems = options.stems === undefined ? undefined : mix.stems(options.stems)
    // Only measured: the WAV goes once it is.
    const scratch = options.out ? undefined : mkdtempSync(join(tmpdir(), 'shaderera-mix-'))
    const out = options.out ?? join(scratch as string, 'mix.wav')
    try {
      mix.wav(out)
      return {
        clips: mix.clips,
        loudness: measureLoudness(out),
        ...(mix.level ? { gainDb: mix.level.gainDb } : {}),
        ...(stems ? { stems } : {}),
      }
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true })
    }
  } finally {
    mix.close()
  }
}

/** The samples ffmpeg's AAC encoder primes with, which an mp4's edit list skips: 21.3 ms. */
const PRIMING = 1024

const RATE = 48000

const s = (n: number) => String(Number(n.toFixed(6)))

/**
 * A heard clip: its file (a project file, or a temporary WAV for `pcm`), for a gain that changes
 * over time its envelope (`gainFile`), its index in the list and its name for errors.
 */
type Clip = SampledClip & {
  readonly file: string
  readonly gainFile?: string
  readonly index: number
  readonly name: string
}

/**
 * The clips heard, in order. A src with no audio stream (a video without sound) is silence, left
 * out as shaderera.com's mix leaves it; a src that cannot be read throws, naming the clip.
 */
const clipFiles = (root: string, clips: readonly SampledClip[]): Clip[] =>
  clips.flatMap((c, index): Clip[] => {
    if ((c.src === undefined) === (c.pcm === undefined))
      throw new Error(
        `Audio clip ${index} needs a src (a project file) or pcm (samples), and only one.`,
      )
    const name = `Audio clip ${index} (${c.src ?? 'pcm'})`
    if (c.src === undefined) return [{ ...c, file: '', index, name }]
    const file = resolve(root, c.src)
    return hasAudio(file, name) ? [{ ...c, file, index, name }] : []
  })

/**
 * Whether a file has an audio stream, by ffprobe. Throws naming the clip when ffprobe cannot read
 * the file.
 */
const hasAudio = (file: string, name: string): boolean => {
  const r = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  )
  if (r.error) throw new Error(`ffprobe is needed to read ${name}: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`${name} cannot be read: ${r.stderr.trim()}`)
  return r.stdout.trim() !== ''
}

/** A pcm clip as a float WAV, an error naming the clip when its samples are not valid. */
const pcmWav = (pcm: Pcm, name: string): Uint8Array => {
  try {
    return floatWav(pcm)
  } catch (error) {
    throw new Error(`${name}: ${(error as Error).message}`)
  }
}

/**
 * Writes the envelope of a gain that changes over time for the window at 48 kHz (interpolated
 * between the host's samples), so ffmpeg multiplies it in sample by sample. Returns the file.
 */
const envelope = (gain: GainCurve, w: Window, file: string): string => {
  const n = Math.max(1, Math.ceil((w.to - w.from) * RATE))
  const env = new Float32Array(n)
  for (let k = 0; k < n; k++) env[k] = gainAt(gain, w.from + k / RATE)
  writeFileSync(file, new Uint8Array(env.buffer))
  return file
}

/** ffmpeg inputs: the clips' files, then the envelopes of clips whose gain changes over time. */
const inputs = (clips: readonly Clip[]): string[] => [
  ...clips.flatMap((c) => ['-i', c.file]),
  ...clips.flatMap((c) =>
    c.gainFile ? ['-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', c.gainFile] : [],
  ),
]

/**
 * The clips as one filter graph ending in `[mix]`: each trimmed to the window (starting at
 * `from`), delayed to its place, given its gain and mixed without amix's default scaling. Clip i is
 * input `first + i`; the envelopes of clips whose gain changes over time follow the clips, in order.
 */
const graph = (clips: readonly Clip[], from: number, first: number): string => {
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
  const labels = clips.map((_, i) => `[a${i}]`).join('')
  return [...chains, `${labels}amix=inputs=${clips.length}:normalize=0:duration=longest[mix]`].join(
    ';',
  )
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

/** The mix as 48 kHz 24-bit stereo PCM WAV, padded or cut to exactly the window's length. */
const wavArgs = (clips: readonly Clip[], w: Window, out: string, gainDb?: number) => [
  '-y',
  '-loglevel',
  'error',
  ...inputs(clips),
  '-filter_complex',
  `${graph(clips, w.from, 0)}${tail(gainDb)}`,
  '-map',
  '[aout]',
  ...['-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', '-t', s(w.to - w.from), out],
]

/** The clips by `group` (clips without one are `ungrouped`), in the order groups first appear. */
const stemsOf = (clips: readonly Clip[]): Map<string, Clip[]> => {
  const groups = new Map<string, Clip[]>()
  for (const c of clips) {
    const name = c.group ?? 'ungrouped'
    if (!/^[\w.-]+$/.test(name))
      throw new Error(`A clip's group names a stem file: letters, digits, . _ - (${name}).`)
    groups.set(name, [...(groups.get(name) ?? []), c])
  }
  return groups
}

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
