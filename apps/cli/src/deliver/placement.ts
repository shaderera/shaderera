import { extname } from 'node:path'
import type { Loudness, Probe } from '../cli/ffmpeg.ts'

/** Margins as fractions of width and height. */
type Margins = { top: number; right: number; bottom: number; left: number }

/**
 * What a placement (a platform's slot: Reels ads, a CTV network, a DOOH screen) accepts, as the
 * person declares it in requirements.json `placements`, from that platform's current spec. Core
 * owns the shape and the check; the numbers are data the person brings (the plugin
 * `format-placement-specs` holds some, with their sources and dates). Every field is optional:
 * only what is declared is checked (decision 0011).
 */
export type Placement = {
  /** A label, and where the numbers come from (a URL and the date it was read). */
  name?: string
  source?: string
  /** `mp4`, `mov`: the file's extension. */
  containers?: string[]
  /** ffprobe's codec names: `h264`, `prores`, `hevc`. */
  videoCodecs?: string[]
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  /** `9:16`, `16:9`: width / height within 1 %. */
  aspect?: string
  /** Frame rates accepted. */
  fps?: number[]
  minDuration?: number
  maxDuration?: number
  /** Exact lengths accepted (spots of 15, 30 s), each within half a frame. */
  durations?: number[]
  maxBytes?: number
  /** Over the whole file, in bits a second. */
  minBitrate?: number
  maxBitrate?: number
  /** `required`: an audio stream; `none`: no audio stream (a silent screen). */
  audio?: 'required' | 'none'
  audioCodecs?: string[]
  sampleRates?: number[]
  minChannels?: number
  /** Integrated loudness within `tolerance` LU of `integrated`, and a true-peak ceiling. */
  loudness?: { integrated?: number; tolerance?: number; maxTruePeak?: number }
  /** `false`: the file must have no edit list (render with --no-edit-list). */
  editList?: false
  /** Text margins, as fractions: review's text-fit judges against them for this output. */
  safeArea?: Margins
}

const mb = (bits: number) => `${(bits / 1e6).toFixed(2)} Mb/s`

/**
 * The file against a placement: one line per declared rule it breaks, and one line of what was
 * measured. An empty list means every declared rule holds.
 */
export const checkPlacement = (
  p: Placement,
  file: string,
  probe: Probe,
  loudness: Loudness | null,
): { failures: string[]; measured: string } => {
  const f: string[] = []
  const v = probe.video
  const container = extname(file).slice(1).toLowerCase()
  if (p.containers && !p.containers.includes(container))
    f.push(`container ${container}, not ${p.containers.join(' or ')}`)
  if (p.videoCodecs && !(v && p.videoCodecs.includes(v.codec)))
    f.push(`video ${v?.codec ?? 'none'}, not ${p.videoCodecs.join(' or ')}`)
  if (v) {
    if (p.width !== undefined && v.width !== p.width) f.push(`width ${v.width}, not ${p.width}`)
    if (p.height !== undefined && v.height !== p.height)
      f.push(`height ${v.height}, not ${p.height}`)
    if (p.minWidth !== undefined && v.width < p.minWidth)
      f.push(`width ${v.width}, below ${p.minWidth}`)
    if (p.minHeight !== undefined && v.height < p.minHeight)
      f.push(`height ${v.height}, below ${p.minHeight}`)
    if (p.aspect) {
      const [w, h] = p.aspect.split(':').map(Number)
      if (w && h && Math.abs(v.width / v.height / (w / h) - 1) > 0.01)
        f.push(`aspect ${v.width}:${v.height}, not ${p.aspect}`)
    }
    if (p.fps && !p.fps.some((r) => Math.abs(r - v.fps) < 0.01))
      f.push(`${Number(v.fps.toFixed(3))} fps, not ${p.fps.join(' or ')}`)
  }
  const half = v ? 0.5 / v.fps : 0.02
  if (p.minDuration !== undefined && probe.duration < p.minDuration - half)
    f.push(`${probe.duration} s, shorter than ${p.minDuration} s`)
  if (p.maxDuration !== undefined && probe.duration > p.maxDuration + half)
    f.push(`${probe.duration} s, longer than ${p.maxDuration} s`)
  if (p.durations && !p.durations.some((d) => Math.abs(d - probe.duration) <= half))
    f.push(`${probe.duration} s, not ${p.durations.join(', ')} s`)
  if (p.maxBytes !== undefined && probe.bytes > p.maxBytes)
    f.push(`${probe.bytes} bytes, over ${p.maxBytes}`)
  if (p.minBitrate !== undefined && probe.bitrate < p.minBitrate)
    f.push(`${mb(probe.bitrate)}, below ${mb(p.minBitrate)} (--bitrate)`)
  if (p.maxBitrate !== undefined && probe.bitrate > p.maxBitrate)
    f.push(`${mb(probe.bitrate)}, above ${mb(p.maxBitrate)} (--maxrate)`)
  const a = probe.audio
  if (p.audio === 'required' && !a) f.push('no audio stream')
  if (p.audio === 'none' && a) f.push('an audio stream on a silent placement (--no-audio)')
  if (a) {
    if (p.audioCodecs && !p.audioCodecs.includes(a.codec))
      f.push(`audio ${a.codec}, not ${p.audioCodecs.join(' or ')}`)
    if (p.sampleRates && !p.sampleRates.includes(a.sampleRate))
      f.push(`${a.sampleRate} Hz, not ${p.sampleRates.join(' or ')}`)
    if (p.minChannels !== undefined && a.channels < p.minChannels)
      f.push(`${a.channels} channels, fewer than ${p.minChannels}`)
  }
  const l = p.loudness
  if (l && a) {
    if (!loudness) f.push('loudness could not be measured')
    else {
      if (
        l.integrated !== undefined &&
        Math.abs(loudness.integrated - l.integrated) > (l.tolerance ?? 1)
      )
        f.push(
          `${loudness.integrated.toFixed(1)} LUFS, not ${l.integrated} ±${l.tolerance ?? 1} (--loudness=${l.integrated})`,
        )
      if (l.maxTruePeak !== undefined && loudness.truePeak > l.maxTruePeak)
        f.push(`true peak ${loudness.truePeak.toFixed(1)} dBTP, above ${l.maxTruePeak}`)
    }
  }
  if (p.editList === false && probe.editList) f.push('an edit list (--no-edit-list)')
  const measured = [
    container,
    v ? `${v.codec} ${v.width}×${v.height} ${Number(v.fps.toFixed(3))} fps` : 'no video',
    `${probe.duration} s`,
    `${(probe.bytes / 1e6).toFixed(2)} MB`,
    mb(probe.bitrate),
    a ? `${a.codec} ${a.sampleRate} Hz ${a.channels} ch` : 'no audio',
    ...(loudness && a ? [`${loudness.integrated.toFixed(1)} LUFS`] : []),
    probe.editList ? 'edit list' : 'no edit list',
  ].join(', ')
  return { failures: f, measured }
}
