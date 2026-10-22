import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { exportFrames, frameTimes, type Manifest, type Sink } from '@shaderera/core'
import { type LightLevels, toSrt, toVtt, windowCaptions } from '@shaderera/core/host'
import {
  chunkFrames,
  type FrameInput,
  isHdr,
  makePlan,
  mostLight,
  readPlan,
  renderChunk,
} from '../deliver/chunks.ts'
import { removePartials } from '../deliver/claim.ts'
import { preflightChunk, preflightPng } from '../deliver/disk.ts'
import { exportFinishing } from '../deliver/finishing.ts'
import { renderReusing } from '../deliver/reuse.ts'
import { refuseSoftware } from '../node/adapter.ts'
import type { Child, ClockReads } from '../node/child.ts'
import { outside } from '../node/inside.ts'
import { frameError, openHosts, reopening } from '../node/open-host.ts'
import type { Project } from '../node/project.ts'
import { findProject } from '../node/project.ts'
import { retriesOf, withRetries } from '../node/retry.ts'
import {
  checkHdr10Delivery,
  DELIVERY_FLAGS,
  deliveryOf,
  openJob,
  readJob,
  safeName,
  videoOptionsOf,
} from '../project/jobs.ts'
import { outputRequirements, readRequirements } from '../project/requirements.ts'
import { save } from '../project/revisions.ts'
import { childOptions, open, parseRendering } from './args.ts'
import { clockOf, clockWarning } from './clock.ts'
import {
  bitsPerSecond,
  CODECS,
  type Codec,
  canEncode,
  containerOf,
  ENCODERS,
  type Encoder,
  FfmpegError,
  ffmpegArgs,
  ffmpegSink,
  forgetEncoder,
  type HdrEncoder,
  hardwareEncoder,
  hasHevcNvenc,
  hdr10Args,
  type Input,
  type Loudness,
  loudnessLine,
  masteringOf,
  measureLoudness,
  type Probe,
  probe,
  probeLine,
  type Quality,
  requireFfmpeg,
  requireFrames,
  requireHdr10,
  requireHdr10Ffmpeg,
} from './ffmpeg.ts'
import { found } from './findings.ts'
import { openMix } from './mix.ts'
import { blackFrame, fileTimecode, prerollOf, prerollTimes, writePreroll } from './preroll.ts'

/**
 * How many hosts an export uses by default (decision 0007): up to 4, two cores left free, at
 * least 30 frames each; one for a sequential source, which cannot be split.
 */
export const defaultWorkers = (manifest: Project['manifest'], frames: number): number =>
  manifest.sequential
    ? 1
    : Math.max(1, Math.min(4, availableParallelism() - 2, Math.floor(frames / 30)))

/** Options a video export shares with jobs and batches: what file, at what rate, with what sound. */
export type VideoOptions = {
  /** `h264` (an mp4; the default) or ProRes (a mov with PCM audio). */
  codec?: Codec
  /** H.264: a constant bitrate such as `15M` (a floor and a ceiling: CTV). */
  bitrate?: string
  /** H.264: a ceiling on the crf's bitrate such as `10M` (DOOH). */
  maxrate?: string
  /** `false`: an mp4 with no edit list, its audio trimmed by the AAC priming (ffmpegArgs). */
  editList?: boolean
  /** One WAV per clip `group` beside the file (`<name>.stems/<group>.wav`), summing to the mix. */
  stems?: boolean
}

/** The file name extension of a codec's container. */
export const extensionOf = (codec: Codec = 'h264') => (codec === 'h264' ? '.mp4' : '.mov')

/** Checks options given on the command line or in a job, before anything renders. */
export const checkVideoOptions = (o: VideoOptions) => {
  if (o.codec !== undefined && !CODECS.includes(o.codec))
    throw new Error(`A codec is ${CODECS.join(', ')}, not ${String(o.codec)}.`)
  if (o.bitrate !== undefined) bitsPerSecond(o.bitrate)
  if (o.maxrate !== undefined) bitsPerSecond(o.maxrate)
  if (o.bitrate !== undefined && o.maxrate !== undefined)
    throw new Error('--bitrate is a constant rate already: give it or --maxrate, not both.')
  if ((o.codec ?? 'h264') !== 'h264' && (o.bitrate || o.maxrate || o.editList === false))
    throw new Error('--bitrate, --maxrate and --no-edit-list are for H.264 in an mp4.')
}

/**
 * Exports [from, to] to an mp4 (H.264) or a mov (ProRes) with ffmpeg; returns the file, frame count
 * and seconds, the file as probed and its sidecars. The file is written as `<out>.<pid>.partial` and
 * renamed to `out` only once complete and probed, so `out` holds the previous film or nothing until
 * then; a render that fails (a source that fails exportFrames's determinism check, a host error,
 * `signal` aborted) leaves no `.partial` and `out` as it was. With `workers` > 1 and `more`, frames are spread over that many hosts
 * (`child` and ones `more` opens) and written in order; the hosts `more` opened are closed here. A
 * host that composites on the GPU hands ffmpeg yuv420p for H.264 and 16-bit RGBA for ProRes.
 * A source with `captions()` gets `<name>.srt` and `<name>.vtt` beside the file.
 *
 * Hosts that render `hdr10` (`has.p010`, decision 0023) make an HDR10 mp4 (HEVC Main 10 from P010)
 * or mov (ProRes from the R'G'B' codes) with the manifest's mastering display and the light levels
 * measured from every frame. The levels are known
 * only after the last frame, so the frames go first into one lossless chunk beside the file
 * (`<out>.<pid>.chunks/`, removed after) and are encoded once from it, as `assemble` encodes a plan.
 */
const exportOnce = async (
  { root, manifest }: Project,
  child: Child,
  o: VideoOptions & {
    from?: number
    to?: number
    out?: string
    quality?: Quality
    crf?: number
    onFrame?: (i: number, n: number) => void
    workers?: number
    more?: () => Promise<Child>
    /**
     * Hosts opened already besides `child` (opened with it, so their opens overlap): the frames go
     * round them instead of `workers` from `more`, and the caller closes them.
     */
    hosts?: readonly Child[]
    /**
     * By default a GPU's H.264 encoder for a review where this machine has one, x264 for a master
     * or without; for HDR10, NVIDIA's HEVC for a review where it works here, x265 for a master or
     * without.
     */
    encoder?: Encoder | HdrEncoder
    /** `false`: no audio stream, whatever the source's clips (a silent DOOH placement, say). */
    audio?: boolean
    /** A loudness to bring the mix to, in LUFS integrated, by one constant gain (openMix). */
    loudness?: number
    /**
     * Frames rendered already (a plan's chunks), in order and in this input format: encoded as
     * they are instead of rendered here. `child` still gives the sound and the captions. P010
     * frames come with their chunks' light levels, the most of each.
     */
    frames?: {
      input: FrameInput
      count: number
      read: () => AsyncIterable<Uint8Array>
      light?: LightLevels
    }
    /** Stops the render between frames (Ctrl-C): it fails as any other error does. */
    signal?: AbortSignal
    /** The revision that made the film, tagged on the file (`shaderera_revision`). */
    revision: string
  },
): Promise<{
  out: string
  frames: number
  seconds: number
  workers: number
  /** `x264`, a GPU encoder, or `prores` for a mov; `x265` or `nvenc` (HEVC) for HDR10. */
  encoder: Encoder | HdrEncoder | 'prores'
  /**
   * Bits a channel the frames reached the encoder with: 16 from the GPU compositor for ProRes, 10
   * for HDR10.
   */
  bits: 8 | 10 | 16
  /** An HDR10 file's light levels as measured (cd/m²), before `-content_light` rounds them up. */
  light?: LightLevels
  /** The file's audio, measured (EBU R128); null without audio. */
  loudness: Loudness | null
  /** The constant gain a requested loudness applied, in dB. */
  gainDb?: number
  /** The file as ffprobe and its boxes report it: codec, bitrate, colour tags, edit list. */
  probe: Probe
  /** The stems written, one per group (with `stems`). */
  stems?: string[]
  /** The caption sidecars written (a source with captions). */
  captions?: string[]
  /** Wall-clock reads inside render, over every host (counted, never blocked). */
  clock: ClockReads
}> => {
  checkVideoOptions(o)
  const codec = o.codec ?? 'h264'
  const prores = codec !== 'h264'
  // The hosts render hdr10, or the frames rendered already are an hdr10 render's.
  const hdr = o.frames ? isHdr(o.frames.input) : child.has.p010 === true
  const review = (o.quality ?? 'review') === 'review'
  const { width, height } = manifest
  let encoder: Encoder | HdrEncoder | 'prores'
  if (hdr) {
    checkHdr10Delivery({ format: prores ? codec : 'mp4', bitrate: o.bitrate, maxrate: o.maxrate })
    requireHdr10Ffmpeg()
    if (!manifest.hdr10) throw new Error('An hdr10 render needs the hdr10 block in shaderera.json.')
    if (o.encoder === 'x264' || o.encoder === 'qsv' || o.encoder === 'amf')
      throw new Error(
        `${o.encoder} encodes H.264: an HDR10 mp4 is HEVC, encoded with x265 or nvenc.`,
      )
    encoder = prores
      ? 'prores'
      : (o.encoder ?? (review && hasHevcNvenc(width, height) ? 'nvenc' : 'x265'))
    if (encoder === 'nvenc' && !hasHevcNvenc(width, height))
      throw new Error(
        'This ffmpeg cannot encode 10-bit HEVC with NVENC here (no NVIDIA GPU, or no driver for it).',
      )
  } else {
    if (o.encoder === 'x265')
      throw new Error('x265 encodes HEVC for HDR10 (--hdr10); an SDR mp4 is H.264.')
    const rated = Boolean(o.bitrate || o.maxrate)
    encoder = prores
      ? 'prores'
      : (o.encoder ??
        (review ? ((await hardwareEncoder(width, height, { rated })) ?? 'x264') : 'x264'))
    if (encoder !== 'prores' && encoder !== 'x264' && !(await canEncode(encoder, width, height)))
      throw new Error(
        `This ffmpeg cannot encode with ${encoder} here (no such GPU, or no driver for it).`,
      )
  }
  requireFfmpeg()
  const from = o.from ?? 0
  const to = o.to ?? manifest.duration
  // A declared preroll comes before `from`: the file, its sound and its captions start at `head`.
  const preroll = prerollOf(manifest)
  const head = from - preroll.seconds
  const out = o.out
    ? resolve(root, o.out)
    : join(root, 'out', `${basename(root)}${extensionOf(codec)}`)
  // Anywhere else in the project, the film would be saved into every later revision.
  if (!outside(root, out) && outside(join(root, 'out'), out))
    throw new Error(
      `${out} is in the project but not in out/: render to out/ or outside the project, since every other file in it is saved into each revision.`,
    )
  mkdirSync(dirname(out), { recursive: true })
  // Named by the process: two renders to one out never write one file or remove each other's.
  const partial = `${out}.${process.pid}.partial`
  // What renders of this out that died (killed, the power cut) left, half written. A film ffprobe
  // reads is one that finished but could not replace out (below): it is kept, and named.
  removePartials(out, '.partial', false, (file) => {
    try {
      probe(file)
    } catch {
      return false
    }
    console.warn(
      `! ${file} is a finished film an earlier render could not move into place: rename it to ${out} to keep it.`,
    )
    return true
  })
  const clips = o.audio === false ? [] : ((await child.audio()) ?? [])
  // The mix's temporary files go in the finally (or with its own throw).
  const mix = openMix(root, clips, { from: head, to }, { loudness: o.loudness })
  const workers = manifest.sequential || !o.more ? 1 : Math.max(1, Math.floor(o.workers ?? 1))
  const start = performance.now()
  const base = out.replace(/\.[^./\\]+$/, '')
  const sidecars: string[] = []
  // Everything that can throw is inside the try, so the hosts opened here are always closed.
  let opened: Child[] = []
  // The finished film when only its rename failed; stems this render began to write.
  let finished = false
  let stemsWritten = false
  // A plain HDR10 render's one chunk, measured before the encode.
  const chunks = `${out}.${process.pid}.chunks`
  try {
    if (!o.hosts) opened = await openHosts(o.more as () => Promise<Child>, workers - 1, workers)
    const hosts = [child, ...(o.hosts ?? opened)] as [Child, ...Child[]]
    let rendered = o.frames
    // An hdr10 render's frames: P010 for HEVC, the R'G'B' codes for ProRes.
    const hdrInput = prores ? 'rgb10' : 'p010'
    if (hdr && !rendered) {
      // What renders of this out that died left of their chunks.
      removePartials(out, '.chunks')
      const plan = makePlan(
        {
          name: basename(base),
          id: o.revision,
          output: { width, height, fps: manifest.fps, from, to },
        },
        hdrInput,
        1,
      )
      const record = await renderChunk(hosts, plan, 0, chunks, o.onFrame, o.signal)
      rendered = {
        input: hdrInput,
        count: record.frames,
        read: () => chunkFrames(plan, chunks),
        ...(record.light ? { light: record.light } : {}),
      }
    }
    // Every host must give the same bytes in the same format.
    const input: FrameInput = rendered
      ? rendered.input
      : prores
        ? hosts.every((h) => h.has.deep)
          ? 'rgba64'
          : 'rgba'
        : hosts.every((h) => h.has.yuv)
          ? 'yuv420p'
          : 'rgba'
    const timecode =
      manifest.timecode || preroll.frames
        ? { timecode: fileTimecode(manifest, from, preroll.frames) }
        : {}
    // AAC's priming (1024 samples), cut from the mix when the mp4 has no edit list to skip it.
    const audio = mix.encode(!prores && o.editList === false)
    if (hdr && !rendered?.light)
      throw new Error('HDR10 frames came without their light levels: render them again.')
    // HDR10: the mastering display declared, and the light of every frame the file holds.
    const hdr10 = hdr
      ? {
          display: masteringOf((manifest.hdr10 as NonNullable<Manifest['hdr10']>).mastering),
          light: mostLight([
            ...(rendered?.light ? [rendered.light] : []),
            ...(await prerollLight(child, {
              ...preroll,
              from,
              fps: manifest.fps,
              input: hdrInput,
            })),
          ]),
        }
      : undefined
    const args = hdr10
      ? hdr10Args({
          width,
          height,
          fps: manifest.fps,
          from: head,
          to,
          ...timecode,
          out: partial,
          container: containerOf(out, codec),
          quality: o.quality,
          crf: o.crf,
          audio,
          input: hdrInput,
          ...(prores ? { codec } : { encoder: encoder as HdrEncoder }),
          display: hdr10.display,
          levels: { maxCLL: hdr10.light.maxCll, maxFALL: hdr10.light.maxFall },
          ...(o.editList === false ? { editList: false } : {}),
          revision: o.revision,
        })
      : ffmpegArgs({
          ...manifest,
          from: head,
          to,
          ...timecode,
          out: partial,
          container: containerOf(out, codec),
          quality: o.quality,
          crf: o.crf,
          audio,
          input: input as Input,
          codec,
          ...(prores ? {} : { encoder: encoder as Encoder }),
          ...(o.bitrate ? { bitrate: o.bitrate } : {}),
          ...(o.maxrate ? { maxrate: o.maxrate } : {}),
          ...(o.editList === false ? { editList: false } : {}),
          revision: o.revision,
        })
    let next = 0
    const sink = ffmpegSink(args, input, codec !== 'prores-4444')
    await writePreroll(sink, {
      ...preroll,
      from,
      fps: manifest.fps,
      black: () => blackFrame(input, width, height),
      render: async (t) => (await child.render(t, 'final', input)).pixels,
    })
    const { frames } = rendered
      ? // A plain HDR10 render counted its frames as it rendered them into its chunk.
        await encodeFrames(sink, rendered, o.frames ? o.onFrame : undefined, o.signal)
      : await exportFrames({
          fps: manifest.fps,
          from,
          to,
          // Frames go round the hosts in the order exportFrames asks for them.
          render: async (t) => {
            const host = hosts[next++ % hosts.length] as Child
            try {
              return (await host.render(t, 'final', input)).pixels
            } catch (error) {
              throw frameError(error, t, manifest.fps, hosts.length)
            }
          },
          inspect: child.has.inspect ? (t) => child.inspect(t) : undefined,
          sink,
          onFrame: o.onFrame,
          signal: o.signal,
          ahead: hosts.length * 2,
        })
    const probed = probe(partial)
    requireFrames(out, probed, preroll.frames + frames)
    if (hdr10)
      requireHdr10(
        out,
        probed,
        hdr10.display,
        { maxCLL: hdr10.light.maxCll, maxFALL: hdr10.light.maxFall },
        prores ? codec : 'hevc',
      )
    const loudness = mix.clips.length > 0 ? measureLoudness(partial) : null
    try {
      renameSync(partial, out)
    } catch (error) {
      // Windows refuses to replace a file another program holds open (a player showing the last
      // film): the new one is finished, so it is kept, never thrown away.
      finished = true
      throw new Error(
        `The film is finished, but ${out} could not be replaced (${(error as NodeJS.ErrnoException).code}): is it open in another program? The new film is ${partial}; close ${out} and rename it.`,
      )
    }
    stemsWritten = o.stems === true && mix.clips.length > 0
    const stems = stemsWritten ? mix.stems(`${base}.stems`) : undefined
    const clock = await clockOf(hosts)
    const captions = await child.captions()
    if (captions) {
      const cues = windowCaptions(captions, head, to)
      writeFileSync(`${base}.srt`, toSrt(cues))
      writeFileSync(`${base}.vtt`, toVtt(cues))
      sidecars.push(`${base}.srt`, `${base}.vtt`)
    }
    return {
      out,
      frames,
      seconds: (performance.now() - start) / 1000,
      workers: hosts.length,
      encoder,
      bits: input === 'rgba64' ? 16 : isHdr(input) ? 10 : 8,
      ...(hdr10 ? { light: hdr10.light } : {}),
      loudness,
      ...(mix.level ? { gainDb: mix.level.gainDb } : {}),
      probe: probed,
      clock,
      ...(stems ? { stems } : {}),
      ...(sidecars.length ? { captions: sidecars } : {}),
    }
  } catch (error) {
    if (!finished) rmSync(partial, { force: true })
    for (const f of sidecars) rmSync(f, { force: true })
    // Only stems this render wrote: the previous film's stay with it.
    if (stemsWritten) rmSync(`${base}.stems`, { recursive: true, force: true })
    throw error
  } finally {
    await Promise.all(opened.map((h) => h.close()))
    mix.close()
    rmSync(chunks, { recursive: true, force: true })
  }
}

/**
 * When a GPU's H.264 encoder was picked from a kept yes (canEncode) and its ffmpeg refuses
 * (encoderRefused), the yes is dropped and the film is rendered again once, with the next encoder
 * found (x264 at the last), saying so on stderr. Never for HDR10, whose HEVC NVENC is asked apart (hasHevcNvenc) and never
 * kept.
 */
const exportFallingBack: typeof exportOnce = async (project, child, o) => {
  const { width, height } = project.manifest
  const auto =
    o.encoder === undefined &&
    (o.codec ?? 'h264') === 'h264' &&
    !(o.frames ? o.frames.input === 'p010' : child.has.p010 === true) &&
    (o.quality ?? 'review') === 'review'
  const picked = auto
    ? await hardwareEncoder(width, height, { rated: Boolean(o.bitrate || o.maxrate) })
    : undefined
  try {
    return await exportOnce(project, child, o)
  } catch (error) {
    if (!picked || !encoderRefused(error)) throw error
    if (!forgetEncoder(picked, width, height)) throw error
    console.warn(`! ${picked} failed where it worked before: rendering again without it.`)
    return exportOnce(project, child, o)
  }
}

/**
 * An encoder ffmpeg that exited with a code other than 0: the encoder itself may have refused (a
 * GPU or driver gone). Not a stall, a signal or an exit with 0 while frames still came (ffmpeg's
 * input ended early): those go to `--retries` only (transientEncoder).
 */
export const encoderRefused = (error: unknown): boolean =>
  error instanceof FfmpegError && error.reason === 'exit' && error.code !== null && error.code !== 0

/**
 * An encoder failure a second try may not repeat: ffmpeg stalled, or exited with 0 while frames
 * were still coming (a demuxer out of memory ends its input), out of memory (AVERROR(ENOMEM): -12;
 * 244 as a POSIX exit status), crashed (a Windows NTSTATUS, 0xC0000000 up) or was ended by a
 * signal. Any other code (a bad option, a missing file) fails the same way again.
 */
export const transientEncoder = (error: unknown): boolean => {
  if (!(error instanceof FfmpegError)) return false
  if (error.reason === 'stall') return true
  const c = error.code
  return (
    c === null ||
    c === 0 ||
    c === -12 ||
    c === 244 ||
    // Signed, as FfmpegError holds it: 0xC0000000 to 0xC0FFFFFF.
    (c >= -0x40000000 && c < -0x3f000000)
  )
}

/**
 * Exports the film (exportOnce, with exportFallingBack's GPU encoder fallback). With `retries`, an
 * encode that fails transiently (transientEncoder) is done again from the start, up to that many
 * times (withRetries): the frames are rendered again (or read again from a plan's chunks), and
 * give the same bytes.
 */
export const exportVideo = async (
  project: Project,
  child: Child,
  o: Parameters<typeof exportOnce>[2] & { retries?: number },
): ReturnType<typeof exportOnce> => {
  const { retries = 0, ...rest } = o
  return withRetries(() => exportFallingBack(project, child, rest), {
    retries,
    transient: transientEncoder,
    what: 'The encode',
    how: 'from the first frame',
    ...(o.signal ? { signal: o.signal } : {}),
  })
}

/**
 * The light of a preroll the source fills (an hdr10 render's), rendered once to be measured before
 * the encode starts; none for black.
 */
const prerollLight = async (
  child: Child,
  o: {
    frames: number
    fill: 'black' | 'source'
    from: number
    fps: number
    input: 'p010' | 'rgb10'
  },
): Promise<LightLevels[]> => {
  if (o.fill !== 'source') return []
  const light: LightLevels[] = []
  for (const t of prerollTimes(o)) {
    const r = await child.render(t, 'final', o.input)
    if (r.light) light.push(r.light)
  }
  return light
}

/**
 * `shaderera render [--job name|file] [--variant name] [--from s] [--to s] [--out path] [--crf 18]
 * [--format mp4|prores-hq|prores-4444] [--master] [--bitrate r | --maxrate r] [--no-edit-list] [--stems]
 * [--progress] [--trusted] [--workers n] [--encoder name] [--no-audio] [--loudness LUFS]
 * [--hdr10] [--force] [--retries n]`. --force: a chunk or png job that the disk-space preflight
 * (deliver/disk.ts) refuses goes ahead. --hdr10: an HDR10 mp4 (HEVC Main 10, decision 0023), or a ProRes mov with --format,
 * of a film whose shaderera.json has `hdr10`, rendered on the GPU through one lossless chunk; a job
 * asks for it when it is made
 * (`shaderera job --hdr10`). --retries: a frame a host failed transiently (crashed, timed out, lost its
 * device) is rendered again on a reopened host, and a transient encoder failure encodes again,
 * up to n times each, with backoff (none by default).
 * --no-audio: no audio stream (or audio.wav), whatever the source's clips. --loudness: bring the
 * mix to that integrated loudness by one constant gain; the true peak is reported, never limited. --workers: how many hosts
 * render frames at once (defaultWorkers; 1 for a sequential source). --encoder (ENCODERS, or x265
 * for --hdr10): by default a GPU encoder for a review where this machine has one, x264 for a master. With --job, the frozen job: its revision, variant, params, seed and
 * window; the working tree does not matter. A png job writes the finishing handoff into
 * out/<job>/ (frames, audio.wav, delivery.json) instead of an mp4. `--job --chunk i [--plan dir]`
 * renders one chunk of a plan; `--job --reuse <plan> --changed <from>-<to>[,…] [--fix] [--plan dir]`
 * writes a plan that renders only the changed spans and reuses the earlier plan's other frames
 * (renderReusing).
 */
const encoderOf = (value: unknown): Encoder | 'x265' => {
  if (value === 'x265') return value
  const found = ENCODERS.find((e) => e === value)
  if (found) return found
  throw new Error(
    `--encoder is one of ${ENCODERS.join(', ')} (x265, nvenc or videotoolbox for --hdr10), not ${String(value)}.`,
  )
}

export const run = async (argv: readonly string[]): Promise<number> => {
  const { values: v } = parseRendering(
    argv,
    {
      job: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      out: { type: 'string' },
      crf: { type: 'string' },
      progress: { type: 'boolean' },
      workers: { type: 'string' },
      encoder: { type: 'string' },
      'no-audio': { type: 'boolean' },
      chunk: { type: 'string' },
      plan: { type: 'string' },
      reuse: { type: 'string' },
      changed: { type: 'string' },
      fix: { type: 'boolean' },
      loudness: { type: 'string' },
      'software-gpu': { type: 'boolean' },
      force: { type: 'boolean' },
      hdr10: { type: 'boolean' },
      retries: { type: 'string' },
      ...DELIVERY_FLAGS,
    },
    { command: 'render', times: false },
  )
  const audio = v['no-audio'] !== true
  const loudness = v.loudness === undefined ? undefined : Number(v.loudness)
  if (loudness !== undefined && !Number.isFinite(loudness))
    throw new Error('--loudness needs LUFS, such as -23 or -14.')
  const retries = retriesOf(v.retries)
  requireFfmpeg()
  const located = await findProject(typeof v.root === 'string' ? v.root : process.cwd())
  const root = located.root
  const job = typeof v.job === 'string' ? readJob(root, v.job) : undefined
  const given = Object.keys(DELIVERY_FLAGS).filter((k) => v[k as keyof typeof v] !== undefined)
  if (job && given.length > 0)
    throw new Error(
      `Job ${job.name} froze its delivery (${job.delivery.format}); --${given.join(', --')} belong to shaderera job.`,
    )
  const delivery = job?.delivery ?? deliveryOf(v)
  if (!job && delivery.format === 'png')
    throw new Error(
      "A png delivery is a job's finishing handoff: shaderera job --png, then render --job.",
    )
  const video = videoOptionsOf(delivery)
  checkVideoOptions(video)
  if (job && v.hdr10 !== undefined)
    throw new Error(
      `Job ${job.name} froze its range (${job.range ?? 'sdr'}); make a new job with shaderera job${v.hdr10 ? ' --hdr10' : ''}.`,
    )
  if (v.hdr10) checkHdr10Delivery(delivery)
  if (job && v.param !== undefined)
    throw new Error(`Job ${job.name} froze its params; make a new job with shaderera job --params.`)
  if (job && v.host !== undefined && v.host !== job.host)
    throw new Error(
      `Job ${job.name} renders in the ${job.host} host; make a new job for --host ${v.host}.`,
    )
  const num = (x: unknown) => (x === undefined ? undefined : Number(x))
  const planDir = (j: { name: string }) =>
    typeof v.plan === 'string' ? resolve(v.plan) : join(root, 'out', `${j.name}.plan`)
  const reusing = v.reuse !== undefined || v.changed !== undefined || v.fix !== undefined
  // How many hosts besides the first the frames go round: --workers, or defaultWorkers for the
  // frames this run renders (a chunk's, the window's; none for a png job's handoff). They open at
  // once with the first, so their opens overlap each other and the save.
  const extraOf = (m: Manifest) => {
    const chunkFrames = () => {
      try {
        return job ? (readPlan(planDir(job)).chunks[Number(v.chunk)]?.frames ?? 0) : 0
      } catch {
        return 0
      }
    }
    const frames =
      reusing || v.chunk === undefined
        ? !reusing && job?.delivery.format === 'png'
          ? 0
          : frameTimes(
              m.fps,
              job?.output.from ?? num(v.from) ?? 0,
              job?.output.to ?? num(v.to) ?? m.duration,
            ).length
        : chunkFrames()
    if (frames === 0 || m.sequential) return 0
    return Math.max(1, Math.floor(num(v.workers) ?? defaultWorkers(m, frames))) - 1
  }
  // The GPU encoders' answers come beside the open (exportVideo asks again, answered).
  if ((video.codec ?? 'h264') === 'h264')
    void hardwareEncoder(located.manifest.width, located.manifest.height)
  const opened = job
    ? await openJob(root, job, childOptions(v), extraOf)
    : await open(v, undefined, extraOf)
  const { project } = opened
  // On a software adapter, refused unless accepted, before anything is saved.
  await refuseSoftware(opened.child, v['software-gpu'] === true).catch(async (error) => {
    await Promise.all([opened.child, ...opened.extra].map((h) => h.close()))
    throw error
  })
  // Ctrl-C stops a video render between frames, so it fails like any other: no .partial is left.
  const stop = new AbortController()
  // --retries: a host that fails a frame transiently is reopened and renders it again.
  const retrying = (h: Child) =>
    retries > 0
      ? reopening(h, opened.more, { retries, fps: project.manifest.fps, signal: stop.signal })
      : h
  const child = retrying(opened.child)
  const extra = opened.extra.map(retrying)
  const hosts = [child, ...extra] as const
  // What the output is traced to: the job's revision, or the working tree saved now (the same
  // files give the same id, so an unchanged project saves nothing new). Saved once the source
  // opened: a render refused before it (an unknown param, a stale bake) saves nothing.
  const revision = job?.revision ?? save(root, { by: 'cli' }).id
  const interrupt = () => stop.abort(new Error('Interrupted: the output was left as it was.'))
  // The progress line goes to a terminal, or to a reader that asks (--progress);
  // piped into a log, it would be one line per frame.
  const progress = process.stderr.isTTY || v.progress === true
  const start = performance.now()
  const onFrame = progress
    ? (i: number, n: number) => {
        const fps = ((i + 1) * 1000) / (performance.now() - start)
        process.stderr.write(`\rframe ${i + 1}/${n}  ${fps.toFixed(1)} fps`)
      }
    : undefined
  try {
    if (reusing) {
      // A plan of the job that renders only the changed spans and reuses an earlier plan's frames.
      if (!job || typeof v.reuse !== 'string' || typeof v.changed !== 'string')
        throw new Error(
          '--reuse renders a job from an earlier plan: shaderera render --job <name> --reuse <plan> --changed <from>-<to>[,…] [--fix].',
        )
      if (v.chunk !== undefined) throw new Error('--reuse renders every changed span: no --chunk.')
      const dir = planDir(job)
      const r = await renderReusing(child, job, project.manifest, {
        reuse: v.reuse,
        changed: v.changed,
        fix: v.fix === true,
        dir,
        onFrame,
        extra,
      }).finally(() => progress && process.stderr.write('\n'))
      const reused = r.plan.chunks.filter((c) => c.reused).reduce((n, c) => n + c.frames, 0)
      for (const c of r.rendered)
        console.log(
          `chunk ${c.index}: ${c.frames} frames from ${Number(c.from.toFixed(4))} s in ${c.seconds.toFixed(1)} s on ${hosts.length} host(s)`,
        )
      if (r.fixed.length > 0)
        console.log(`--fix: rendered around frames ${r.fixed.join(', ')}, which differed`)
      console.log(
        `${join(dir, 'plan.json')}: ${r.rendered.reduce((n, c) => n + c.frames, 0)} frames rendered, ${reused} reused from ${resolve(v.reuse)}; ${r.samples} reused frames rendered again matched`,
      )
      console.log(`then: npx shaderera assemble --plan ${dir}`)
      return 0
    }
    if (v.chunk !== undefined) {
      // One chunk of a plan: this machine's share, into the plan's folder.
      if (!job)
        throw new Error(
          '--chunk renders a chunk of a job: shaderera render --job <name> --chunk <i>.',
        )
      const dir = planDir(job)
      const plan = readPlan(dir)
      if (plan.jobId !== job.id)
        throw new Error(`${dir} is a plan of another job (${plan.job}, ${plan.jobId.slice(0, 8)}).`)
      const force = v.force === true
      await preflightChunk(child, plan, Number(v.chunk), dir, {
        sequential: project.manifest.sequential,
        force,
      })
      process.once('SIGINT', interrupt)
      process.once('SIGTERM', interrupt)
      const r = await renderChunk(hosts, plan, Number(v.chunk), dir, onFrame, stop.signal).finally(
        () => progress && process.stderr.write('\n'),
      )
      console.log(
        `chunk ${r.index}: ${r.frames} frames in ${r.seconds.toFixed(1)} s on ${hosts.length} host(s) → ${join(dir, plan.chunks[r.index]?.file ?? '')}`,
      )
      return 0
    }
    if (job?.delivery.format === 'png') {
      const dir = typeof v.out === 'string' ? resolve(v.out) : join(root, 'out', job.name)
      const force = v.force === true
      await preflightPng(child, job, dir, { sequential: project.manifest.sequential, force })
      const done = await exportFinishing(project, child, job, {
        dir,
        requirements: outputRequirements(readRequirements(root), {
          variant: job.variant,
          ...job.output,
          duration: job.output.to - job.output.from,
          textless: project.manifest.textless === true,
        }),
        quick: true,
        audio,
        loudness,
        onFrame,
        ...(job.delivery.bits ? { bits: job.delivery.bits } : {}),
        ...(job.delivery.stems ? { stems: true } : {}),
      }).finally(() => progress && process.stderr.write('\n'))
      console.log(
        `${done.dir}\n${done.record.frameCount} frames in ${done.seconds.toFixed(1)} s: ${done.rendered} rendered, ${done.kept} already there`,
      )
      if (done.record.audio?.loudness)
        console.log(`audio: ${loudnessLine(done.record.audio.loudness)}`)
      return 0
    }
    // Only around a chunk and the video export: a png job keeps the default Ctrl-C.
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', interrupt)
    const from = job?.output.from ?? num(v.from) ?? 0
    const to = job?.output.to ?? num(v.to) ?? project.manifest.duration
    const ext = extensionOf(video.codec)
    const { out, frames, seconds, workers, encoder, ...sound } = await exportVideo(project, child, {
      ...video,
      from,
      to,
      hosts: extra,
      out:
        typeof v.out === 'string'
          ? resolve(v.out)
          : job
            ? join(root, 'out', `${job.name}${ext}`)
            : typeof v.variant === 'string'
              ? join(root, 'out', `${basename(root)}-${safeName(v.variant)}${ext}`)
              : undefined,
      quality: delivery.quality,
      crf: num(v.crf),
      audio,
      loudness,
      onFrame,
      signal: stop.signal,
      revision,
      retries,
      ...(v.encoder === undefined ? {} : { encoder: encoderOf(v.encoder) }),
    }).finally(() => progress && process.stderr.write('\n'))
    console.log(
      `${out}\n${frames} frames in ${seconds.toFixed(1)} s on ${workers} host(s), ${encoder}`,
    )
    console.log(`file: ${probeLine(sound.probe)}${sound.bits === 16 ? ', from 16-bit frames' : ''}`)
    if (sound.light) console.log(`light: ${lightLine(sound.light)}`)
    console.log(`revision: ${revision}`)
    for (const f of [...(sound.stems ?? []), ...(sound.captions ?? [])]) console.log(f)
    if (sound.loudness)
      console.log(
        `audio: ${loudnessLine(sound.loudness)}${sound.gainDb === undefined ? '' : ` (gain ${sound.gainDb.toFixed(2)} dB for ${loudness} LUFS)`}`,
      )
    else if (loudness !== undefined) console.log('audio: none to bring to a loudness')
    console.log(`host: ${JSON.stringify(await child.identity())}`)
    const warning = clockWarning(sound.clock)
    if (warning) {
      console.warn(`! ${warning}`)
      found({ code: 'clock', severity: 'warning', message: warning })
    }
    return 0
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    await Promise.all(extra.map((h) => h.close()))
    await child.close()
  }
}

/** An HDR10 file's measured light levels as one line, as `-content_light` writes them. */
export const lightLine = (l: LightLevels) =>
  `MaxCLL ${Number(l.maxCll.toFixed(2))} cd/m², MaxFALL ${Number(l.maxFall.toFixed(2))} cd/m² measured (the file says ${Math.ceil(l.maxCll)} / ${Math.ceil(l.maxFall)})`

/** Writes frames rendered elsewhere into the encoder, counting them against what was planned. */
const encodeFrames = async (
  sink: Sink,
  f: { count: number; read: () => AsyncIterable<Uint8Array> },
  onFrame?: (i: number, n: number) => void,
  signal?: AbortSignal,
): Promise<{ frames: number }> => {
  let frames = 0
  try {
    for await (const pixels of f.read()) {
      signal?.throwIfAborted()
      await sink.write(pixels)
      onFrame?.(frames, f.count)
      frames++
    }
    if (frames !== f.count) throw new Error(`${frames} frames came, not the ${f.count} planned.`)
    await sink.end()
  } catch (error) {
    await sink.abort?.()
    throw error
  }
  return { frames }
}
