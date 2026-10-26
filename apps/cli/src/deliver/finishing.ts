import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { exportFrames, frameTimes, type Json, NotDeterministic } from '@shaderera/core'
import { fpsFraction, toSrt, toVtt, windowCaptions } from '@shaderera/core/host'
import { type Loudness, requireFfmpeg } from '../cli/ffmpeg.ts'
import { mixWav } from '../cli/mix.ts'
import { blackFrame, fileTimecode, prerollOf, writePreroll } from '../cli/preroll.ts'
import type { Child, ClockReads, HostIdentity } from '../node/child.ts'
import type { Project } from '../node/project.ts'
import type { Job } from '../project/jobs.ts'
import type { Requirements } from '../project/requirements.ts'
import { slash } from '../project/revisions.ts'
import { type ReviewReport, review } from '../review/review.ts'
import { ffmpegVersion, shadereraVersion } from './environment.ts'
import { encodePng } from './png.ts'

export const COLOR_STATEMENT =
  '8-bit sRGB, straight alpha; display-referred; not scene-linear. BT.709 primaries, sRGB transfer.'
/** The colour statement of a 16-bit handoff: the same encoding, with the compositor's precision. */
const COLOR_STATEMENT_16 = COLOR_STATEMENT.replace('8-bit', '16-bit')

/** What `delivery.json` says about a finishing handoff. */
export type DeliveryRecord = {
  shaderera: 'delivery/1'
  job: string
  revision: string
  variant?: string
  params: { [key: string]: Json }
  seed: number
  width: number
  height: number
  fps: number
  from: number
  to: number
  frameCount: number
  /** The rate as a fraction for an NTSC rate (`30000/1001`), else as a number. */
  rate: string
  /** The first frame's: HH:MM:SS:FF, or HH:MM:SS;FF drop-frame at 29.97 and 59.94. */
  startTimecode: string
  /** Frames before the programme (frames/000000.png onward), black or the source's own. */
  preroll?: { frames: number; seconds: number; fill: 'black' | 'source' }
  /** A textless version. */
  textless?: true
  color: string
  frames: { file: string; sha256: string }[]
  audio: {
    file: string
    format: string
    sampleRate: number
    channels: number
    /** The WAV as measured (EBU R128). */
    loudness?: Loudness
    /** The constant gain a requested loudness applied, in dB. */
    gainDb?: number
    /** One WAV per clip group, summing to `file`. */
    stems?: string[]
  } | null
  /** SRT and WebVTT sidecars from the source's captions. */
  captions?: string[]
  review: { contactSheet: string; checks: { id: string; status: string; measured?: string }[] }
  /**
   * `host`: the host that rendered the frames (Node and its webgpu, adapter and feature count, or
   * the browser and its flags and adapter).
   */
  versions: { shaderera: string; ffmpeg: string; host: HostIdentity }
  /** Wall-clock reads inside render while the frames were made (counted, never blocked). */
  clock: ClockReads
}

/** What `<dir>.partial/partial.json` says: whose frames the unfinished folder holds. */
type PartialRecord = { shaderera: 'partial/1'; job: string; jobId: string; bits: 8 | 16 }

/** A PNG ends with its IEND chunk: a file cut short does not. */
const IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])

const frameFile = (i: number) => `frames/${String(i).padStart(6, '0')}.png`

/**
 * The frames an earlier run of the same job left in `partial`, from 000000.png up to the first
 * missing or incomplete one, with their hashes. Null when there is no such folder; a folder of
 * another job (or of none) is refused, so a frame is never reused across jobs or revisions.
 */
const keptFrames = (partial: string, record: PartialRecord): DeliveryRecord['frames'] | null => {
  if (!existsSync(partial)) return null
  const file = join(partial, 'partial.json')
  const was = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as PartialRecord) : null
  if (was?.shaderera !== 'partial/1' || was.jobId !== record.jobId || was.bits !== record.bits)
    throw new Error(
      `${partial} holds frames ${was ? `of job ${was.job} (${String(was.jobId).slice(0, 8)}, ${was.bits}-bit)` : 'of no known job'}, not of ${record.job} (${record.jobId.slice(0, 8)}, ${record.bits}-bit): delete it or choose another --out.`,
    )
  // A frame cut off while it was written is a temporary file: never a frame.
  for (const f of existsSync(join(partial, 'frames')) ? readdirSync(join(partial, 'frames')) : [])
    if (f.endsWith('.tmp')) rmSync(join(partial, 'frames', f), { force: true })
  const frames: DeliveryRecord['frames'] = []
  for (;;) {
    const path = join(partial, frameFile(frames.length))
    if (!existsSync(path)) break
    const png = readFileSync(path)
    if (png.length < IEND.length || !png.subarray(-IEND.length).equals(IEND)) break
    frames.push({
      file: frameFile(frames.length),
      sha256: createHash('sha256').update(png).digest('hex'),
    })
  }
  return frames
}

/**
 * The finishing handoff of a job: `<dir>/frames/000000.png …` (8-bit RGBA, straight alpha),
 * `<dir>/audio.wav` (48 kHz PCM, the mp4's mix; only when the source has audio) and
 * `<dir>/delivery.json`, plus the review in `<dir>/review/`. It is written in `<dir>.partial` and
 * moved into place once exportFrames's determinism re-check passes. It replaces `<dir>` only when
 * that is empty or a previous delivery (it holds a delivery.json), and refuses before rendering
 * otherwise.
 *
 * Each frame is written to a temporary name and renamed, so a frame file is always whole. A run
 * that fails keeps the frames it finished in `<dir>.partial` (except a source that fails the
 * determinism re-check: its frames go); running the same job again continues from the first frame
 * missing there (`kept`). A `<dir>.partial` of another job is refused.
 */
export const exportFinishing = async (
  project: Project,
  child: Child,
  job: Job,
  o: {
    dir: string
    requirements?: Requirements
    quick?: boolean
    /** `false`: no audio.wav, whatever the source's clips. */
    audio?: boolean
    /** A loudness to bring the mix to, in LUFS integrated, by one constant gain (openMix). */
    loudness?: number
    onFrame?: (i: number, n: number, phase?: 'recheck') => void
    /** 16: frames at 16 bits a channel, from the GPU compositor (a host without one refuses). */
    bits?: 8 | 16
    /** Write `stems/<group>.wav` beside audio.wav. */
    stems?: boolean
  },
): Promise<{
  dir: string
  record: DeliveryRecord
  review: ReviewReport
  seconds: number
  /** Frames this run rendered, and frames an earlier run of the job had left. */
  rendered: number
  kept: number
}> => {
  const dir = resolve(o.dir)
  if (existsSync(dir) && readdirSync(dir).length > 0 && !existsSync(join(dir, 'delivery.json')))
    throw new Error(
      `${dir} is not empty and is not a delivery (no delivery.json): it would be replaced. Choose another --out.`,
    )
  requireFfmpeg()
  const start = performance.now()
  const partial = `${dir}.partial`
  const { width, height, fps } = project.manifest
  const { from, to } = job.output
  // A declared preroll comes first: frames, sound and captions start at `head`.
  const preroll = prerollOf(project.manifest)
  const head = from - preroll.seconds
  const bits = o.bits ?? 8
  if (bits === 16 && !child.has.deep)
    throw new Error(
      '16-bit frames come from the GPU compositor: this host has none (a Node project needs webgpu).',
    )
  const partialRecord: PartialRecord = {
    shaderera: 'partial/1',
    job: job.name,
    jobId: job.id,
    bits,
  }
  const total = preroll.frames + frameTimes(fps, from, to).length
  const frames = (keptFrames(partial, partialRecord) ?? []).slice(0, total)
  const kept = frames.length
  mkdirSync(join(partial, 'frames'), { recursive: true })
  writeFileSync(join(partial, 'partial.json'), `${JSON.stringify(partialRecord, null, 1)}\n`)
  let placed = false
  try {
    // The first `kept` frames are there: the preroll's are passed over, exportFrames skips the rest.
    let at = kept < preroll.frames ? 0 : kept
    const sink = {
      write: async (pixels: Uint8Array | Uint8ClampedArray) => {
        if (at++ < kept) return
        const png = encodePng(pixels, width, height, bits)
        const file = frameFile(frames.length)
        const tmp = join(partial, `${file}.tmp`)
        writeFileSync(tmp, png)
        renameSync(tmp, join(partial, file))
        frames.push({ file, sha256: createHash('sha256').update(png).digest('hex') })
      },
      end: async () => {},
    }
    if (kept < preroll.frames)
      await writePreroll(sink, {
        ...preroll,
        from,
        fps,
        black: () => blackFrame(bits === 16 ? 'rgba64' : 'rgba', width, height),
        render: async (t) =>
          (await child.render(t, 'final', bits === 16 ? 'rgba64' : 'rgba')).pixels,
      })
    await exportFrames({
      fps,
      from,
      to,
      render: async (t) => (await child.render(t, 'final', bits === 16 ? 'rgba64' : 'rgba')).pixels,
      inspect: child.has.inspect ? (t) => child.inspect(t) : undefined,
      sequential: Boolean(child.has.sequential),
      sink,
      skip: Math.max(0, kept - preroll.frames),
      onFrame: o.onFrame && ((i, n) => o.onFrame?.(i, n)),
      onRecheck: o.onFrame && ((i, n) => o.onFrame?.(i, n, 'recheck')),
    })
    // The mix's temporary files go even on a throw; a source with nothing heard has no audio.wav.
    const mixed = mixWav(
      project.root,
      o.audio === false ? [] : ((await child.audio()) ?? []),
      { from: head, to },
      {
        out: join(partial, 'audio.wav'),
        ...(o.stems ? { stems: join(partial, 'stems') } : {}),
        ...(o.loudness === undefined ? {} : { loudness: o.loudness }),
      },
    )
    const audio: DeliveryRecord['audio'] =
      mixed.clips.length === 0
        ? null
        : {
            file: 'audio.wav',
            format: 'WAV PCM signed 24-bit',
            sampleRate: 48000,
            channels: 2,
            ...(mixed.loudness ? { loudness: mixed.loudness } : {}),
            ...(mixed.gainDb === undefined ? {} : { gainDb: Number(mixed.gainDb.toFixed(3)) }),
            ...(mixed.stems
              ? { stems: mixed.stems.map((file) => slash(relative(partial, file))) }
              : {}),
          }
    const cues = await child.captions()
    const captions = cues ? ['captions.srt', 'captions.vtt'] : undefined
    if (cues) {
      const inWindow = windowCaptions(cues, head, to)
      writeFileSync(join(partial, 'captions.srt'), toSrt(inWindow))
      writeFileSync(join(partial, 'captions.vtt'), toVtt(inWindow))
    }
    rmSync(join(partial, 'review'), { recursive: true, force: true })
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    renameSync(partial, dir)
    placed = true
    const report = await review({
      project,
      child,
      outDir: join(dir, 'review'),
      requirements: o.requirements,
      quick: o.quick,
    })
    const record: DeliveryRecord = {
      shaderera: 'delivery/1',
      job: job.name,
      revision: job.revision,
      ...(job.variant ? { variant: job.variant } : {}),
      params: job.params,
      seed: job.seed,
      width,
      height,
      fps,
      from,
      to,
      frameCount: frames.length,
      rate: fpsFraction(fps),
      startTimecode: fileTimecode(project.manifest, from, preroll.frames),
      ...(preroll.frames
        ? { preroll: { frames: preroll.frames, seconds: preroll.seconds, fill: preroll.fill } }
        : {}),
      ...(project.manifest.textless ? { textless: true } : {}),
      color: bits === 16 ? COLOR_STATEMENT_16 : COLOR_STATEMENT,
      frames,
      audio,
      ...(captions ? { captions } : {}),
      review: {
        contactSheet: slash(relative(dir, report.contactSheet)),
        checks: report.checks.map((c) => ({
          id: c.id,
          status: c.status,
          ...(c.measured ? { measured: c.measured } : {}),
        })),
      },
      versions: {
        shaderera: shadereraVersion(),
        ffmpeg: ffmpegVersion() ?? 'not found',
        host: await child.identity(),
      },
      clock: await child.clock(),
    }
    rmSync(join(dir, 'partial.json'), { force: true })
    writeFileSync(join(dir, 'delivery.json'), `${JSON.stringify(record, null, 1)}\n`)
    const seconds = (performance.now() - start) / 1000
    return { dir, record, review: report, seconds, rendered: frames.length - kept, kept }
  } catch (error) {
    // Frames that differ when rendered again cannot be continued from: they go.
    if (error instanceof NotDeterministic) {
      rmSync(partial, { recursive: true, force: true })
      if (placed) rmSync(dir, { recursive: true, force: true })
      throw error
    }
    // The frames stay for the next run of the job (moved back if they were already in place).
    if (placed) renameSync(dir, partial)
    if (error instanceof Error && frames.length > 0)
      error.message += ` (${frames.length} frames kept in ${partial}: render the job again to continue)`
    throw error
  }
}
