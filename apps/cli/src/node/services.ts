// What the hosts ask of the CLI's own process, which may write files and run ffmpeg where a
// project's code may not: the derived-data cache, decoded stills, decoded video frames and baked
// frames. The Node host asks
// over IPC (child.ts), the browser host's worker over the runner server (runner-plugin.ts).
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { VideoColour } from '@shaderera/core'
import { imageSize } from '../runner/image.ts'
import { IMAGE_WASM } from '../runner/image-wasm.ts'
import type { StillSize } from '../runner/io.ts'
import { frameBytes, type VideoFormat } from './decoder.ts'
import { insideForRead } from './inside.ts'
import { lendTurns } from './spawn-turn.ts'
import type { FromStill } from './still-worker.ts'
import type { FromVideo, ToVideo, VideoAsk } from './video-worker.ts'

/** The frames a host may read, by bake: absolute files, in order, checked against their stamps. */
export type BakeFrames = { readonly [name: string]: readonly string[] }

/** A request from a host. */
export type ServiceRequest =
  | { op: 'cache-get'; hash: string }
  | { op: 'cache-put'; hash: string; bytes: Uint8Array }
  | { op: 'image-open'; path: string; maxSize?: number }
  | { op: 'image-data'; key: string }
  | { op: 'video-open'; path: string; declared?: boolean }
  | { op: 'video-frame'; path: string; index: number; format?: VideoFormat }
  | { op: 'video-close'; path: string }
  | { op: 'bake-open'; name: string }
  | { op: 'bake-frame'; name: string; index: number }

export type VideoInfo = {
  width: number
  height: number
  fps: number
  frames: number
  /** Its sample depth (sampleBits). */
  bits: 8 | 10 | 12 | 16
  /** Its `yuv420p` planes' colour, as the decoder makes them (videoColour). */
  colour: VideoColour
  /** Its pixel format carries alpha: it refuses `yuv420p` and `yuv420p10`. */
  alpha: boolean
}

/**
 * The sample depth of an ffprobe `pix_fmt` (ADR 0031, 1), as `Footage.bits` names it: 9 bits count
 * as 10 and 14 as 16; 48- and 64-bit RGB are 16.
 */
export const sampleBits = (pixFmt: string): VideoInfo['bits'] => {
  const n = /(?:rgba?|bgra?)(?:48|64)/.test(pixFmt)
    ? 16
    : Number((/(?:p|gray)(\d\d?)(?:le|be)$/.exec(pixFmt) ?? /^p0(\d\d)/.exec(pixFmt))?.[1] ?? 8)
  return n <= 8 ? 8 : n <= 10 ? 10 : n <= 12 ? 12 : 16
}

/** ffprobe's matrices as the RGBA path's `in_color_matrix=auto` reads them; others are BT.601. */
const MATRIX: { [tag: string]: VideoColour['matrix'] } = {
  bt709: 'bt709',
  bt2020nc: 'bt2020nc',
  bt2020c: 'bt2020nc',
}

/**
 * The colour of a file's `yuv420p` planes (ADR 0027, 1), from ffprobe's stream: the file's matrix
 * and range, or for an untagged file what swscale's `auto` takes (BT.601, limited; full for
 * `yuvj*`), measured on ffmpeg 9.0. A 4:2:0 file keeps its chroma siting (left for an untagged
 * H.264 or HEVC, center for MJPEG, as ffprobe says); swscale subsamples any other to `left`, as
 * the decoder asks it to.
 */
export const videoColour = (s: {
  pix_fmt?: string
  color_space?: string
  color_range?: string
  chroma_location?: string
  codec_name?: string
}): VideoColour => {
  const pix = String(s.pix_fmt)
  const sited = /^yuvj?420p/.test(pix) ? s.chroma_location : 'left'
  return {
    matrix: MATRIX[String(s.color_space)] ?? 'bt601',
    range: s.color_range === 'pc' || pix.startsWith('yuvj') ? 'full' : 'limited',
    chroma:
      sited === 'left' || sited === 'center' || sited === 'topleft'
        ? sited
        : s.codec_name === 'mjpeg'
          ? 'center'
          : 'left',
  }
}

/**
 * A video's first stream as `io.video` gives it: width, height, fps, the frames counted from its
 * packets, and its planes' colour (ffprobe).
 */
export const probeVideo = (file: string): VideoInfo => {
  const r = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-count_packets',
      '-show_entries',
      'stream=width,height,r_frame_rate,nb_read_packets,codec_name,pix_fmt,color_space,color_range,chroma_location',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8' },
  )
  if (r.error) throw new Error(`ffprobe is needed to read ${file}: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`ffprobe cannot read ${file}: ${r.stderr.trim()}`)
  const s = (JSON.parse(r.stdout) as { streams: { [k: string]: string | number }[] }).streams[0]
  if (!s) throw new Error(`${file} has no video stream.`)
  const [n, d] = String(s.r_frame_rate).split('/').map(Number)
  return {
    width: Number(s.width),
    height: Number(s.height),
    fps: d ? (n as number) / d : (n as number),
    frames: Number(s.nb_read_packets),
    bits: sampleBits(String(s.pix_fmt)),
    colour: videoColour(s as { [k: string]: string }),
    alpha: /^(yuva|gbrap|ya\d|rgba|bgra|argb|abgr)/.test(String(s.pix_fmt)),
  }
}

/**
 * The longest keyframe gap, in seconds, of each clip file a decoder of this process read the
 * packets of to seek (decoder.ts, keyGap): `check` notes the long ones.
 */
export const keyGaps = new Map<string, number>()

/**
 * Each clip file of more than 8 bits a host of this process opened (#575): whether every open
 * declared its space, and whether its frames were read at 8 bits (`rgba`, `yuv420p`) or at 10.
 * `check` warns of the undeclared ones and of those read only at 8.
 */
export const deepFootage = new Map<
  string,
  { bits: VideoInfo['bits']; declared: boolean; at8: boolean; at10: boolean }
>()

/**
 * A clip as a draft render's io.video gives it (render --draft): scaled each side as the frame is,
 * so that it keeps its place in the smaller frame.
 */
export const scaledVideo = (info: VideoInfo, scale: number): VideoInfo => ({
  ...info,
  width: Math.max(1, Math.round(info.width * scale)),
  height: Math.max(1, Math.round(info.height * scale)),
})

/**
 * How many bytes of frames a clip's decoder runs ahead at most: 128 MiB (one frame if larger),
 * doubled with the window (ADR 0030, step 1).
 */
export const AHEAD_BYTES = 128 * 1024 * 1024

/**
 * One file's frames as `io.video` gives them, decoded in a thread of its own (video-worker.ts,
 * videoDecoder): the decoder's pipe and the copy of every frame out of it stay off this thread,
 * which takes every host's frames (#434). Each frame comes as bytes of its own. `keep()` and
 * `ahead()` are videoDecoder's, asked at each frame.
 */
export const videoReader = (
  file: string,
  keep: () => number = () => 1,
  ahead: () => number = keep,
  /** For tests: another thread in video-worker.ts's place. */
  thread: URL = new URL(`./video-worker${extname(import.meta.url)}`, import.meta.url),
  /** A draft render's: the frames scaled by this much each side, by the decoder (scaledVideo). */
  scale = 1,
  format: VideoFormat = 'rgba',
) => {
  const scaled = scale !== 1
  const info = scaled ? scaledVideo(probeVideo(file), scale) : probeVideo(file)
  // The planes have no alpha: dropping it would change the look without the author (ADR 0027, 1).
  if (format !== 'rgba' && info.alpha)
    throw new Error(`${file} has alpha, which ${format} cannot carry: ask for its frames as rgba.`)
  const { turn, transfer } = lendTurns()
  const worker = new Worker(thread, {
    workerData: { file, info, scaled, format, turn },
    transferList: transfer,
  })
  // Only while it answers a request: an idle decoder does not keep the CLI running.
  worker.unref()
  let pid: number | undefined
  let next = 0
  const asked = new Map<
    number,
    { done: (v: Uint8Array | null) => void; fail: (e: Error) => void }
  >()
  worker.on('message', (m: FromVideo) => {
    pid = m.pid
    if (m.keyGap !== undefined) keyGaps.set(file, m.keyGap)
    const a = asked.get(m.id)
    asked.delete(m.id)
    if (asked.size === 0) worker.unref()
    if (m.error !== undefined) a?.fail(new Error(m.error))
    else a?.done(m.bytes ?? null)
  })
  // Set once the thread is gone: every request from then on fails with it at once.
  let dead: Error | undefined
  const gone = (error: Error) => {
    dead ??= error
    for (const a of asked.values()) a.fail(error)
    asked.clear()
  }
  worker.on('error', gone)
  worker.on('exit', () => gone(new Error(`The decoder of ${file} has stopped.`)))
  // Frames decoded ahead, at most AHEAD_BYTES of them and never fewer than one.
  const size = frameBytes(format, info.width, info.height)
  const capped = () => Math.max(1, Math.min(ahead(), Math.floor(AHEAD_BYTES / size)))
  const ask = (m: VideoAsk) =>
    new Promise<Uint8Array | null>((done, fail) => {
      if (dead) return fail(dead)
      const id = next++
      asked.set(id, { done, fail })
      worker.ref()
      worker.postMessage({ ...m, id, keep: keep(), ahead: capped() } as ToVideo)
    })
  return {
    info,
    frame: async (index: number) => (await ask({ type: 'frame', index })) as Uint8Array,
    /** Ends the decoder and drops what it decoded; the next frame starts another. */
    close: async () => {
      await ask({ type: 'close' })
    },
    /**
     * Ends the decoder and its thread: the reader is not used again. Never fails: a thread that
     * dies before it answers is gone all the same (and a host's exit awaits nothing of it).
     */
    dispose: async () => {
      if (!dead) await ask({ type: 'close' }).catch(() => {})
      await worker.terminate()
    },
    /** Why the thread is gone, once it is: the reader is then of no use. */
    get dead() {
      return dead
    },
    /** The decoder's process id, while one runs. */
    get pid() {
      return pid
    },
  }
}

/**
 * The clips open in this process, each with the hosts using it. Several hosts of one render ask
 * frames in turn, so one decoder serves them all, keeping two frames a host and one: a frame is
 * decoded once, not once a host, and one asked a little late (another host's, or the frame a
 * re-check inspects after the next was asked for) is still there. It decodes two frames a host and
 * one ahead of the latest asked (ADR 0030), so a host's next frame is usually there when it asks.
 */
const shared = new Map<string, { reader: ReturnType<typeof videoReader>; users: Set<object> }>()
/** The process ids of this process's clip decoders that run now. */
export const clipDecoders = (): number[] =>
  [...shared.values()].flatMap((v) => (v.reader.pid === undefined ? [] : [v.reader.pid]))

/**
 * How many bytes a film's cache (`.shaderera/cache/`) may hold: 1 GiB, or
 * `SHADERERA_FILM_CACHE_MB` megabytes.
 */
export const cacheLimit = (env: NodeJS.ProcessEnv = process.env): number => {
  const mb = env.SHADERERA_FILM_CACHE_MB
  if (mb === undefined || mb === '') return 1024 * 1024 * 1024
  const n = Number(mb)
  if (!Number.isFinite(n) || n < 0)
    throw new Error(`SHADERERA_FILM_CACHE_MB is a number of megabytes, not ${JSON.stringify(mb)}.`)
  return Math.floor(n * 1024 * 1024)
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
/** The decoder's version in a still's key: the module itself, so a new crate or filter is a new key. */
let decoderTag: string | undefined

/** `bytes` decoded in a thread of its own (still-worker.ts), which ends after. */
const decodeStill = (bytes: Uint8Array, path: string, maxSize?: number) =>
  new Promise<Uint8Array>((done, fail) => {
    const worker = new Worker(
      new URL(`./still-worker${extname(import.meta.url)}`, import.meta.url),
      {
        workerData: { bytes, path, maxSize },
      },
    )
    worker.once('message', (m: FromStill) => {
      if (m.data) done(m.data)
      else fail(new Error(m.error))
      void worker.terminate()
    })
    worker.once('error', fail)
    worker.once('exit', () => fail(new Error(`The decoder of ${path} has stopped.`)))
  })

/**
 * The stills decoded in this process, by key, each with the hosts using it (ADR 0028, 1): hosts
 * asking for one at once share its decode, and it is kept until the last of them closes.
 */
const stills = new Map<string, { data: Promise<Uint8Array>; users: Set<object> }>()
/** How many stills this process decoded rather than read from the cache (for tests). */
export const stillsDecoded = { count: 0 }

/** A cache entry's name: its key. Anything else there (a host's file being written) is not one. */
const ENTRY = /^[0-9a-f]{64}$/

/**
 * Removes the least recently used entries of a cache folder until it holds at most `limit` bytes,
 * never `keep` (the entry just put). An entry's modification time is its last use: a put writes
 * it and a get touches it. A file another host is writing (`<key>.<uuid>`) is not an entry, and one
 * that cannot be removed now is left.
 */
const evict = (dir: string, limit: number, keep: string) => {
  const entries = readdirSync(dir)
    .filter((n) => ENTRY.test(n))
    .flatMap((name) => {
      try {
        const s = statSync(join(dir, name))
        return [{ name, size: s.size, used: s.mtimeMs }]
      } catch {
        return []
      }
    })
  let total = entries.reduce((sum, e) => sum + e.size, 0)
  for (const e of entries.sort((a, b) => a.used - b.used)) {
    if (total <= limit) break
    if (e.name === keep) continue
    try {
      rmSync(join(dir, e.name))
      total -= e.size
    } catch {}
  }
}

/**
 * The services for one project: answers each request, or throws. `bakes` are the frames of each
 * bake, checked against its stamp before the source opened (project/bakes.ts): the only files
 * outside the project a host may read. A clip has one decoder for every host of this process that
 * opened it (`shared`), and it ends when the last of them closes it. The cache holds at most
 * `cacheLimit` bytes, dropping the least recently used entries past it.
 */
export const createServices = (
  root: string,
  bakes: BakeFrames = {},
  o: { cacheLimit?: number; videoScale?: number } = {},
) => {
  const limit = o.cacheLimit ?? cacheLimit()
  // A draft's clips are decoded at another size (scaledVideo): decoders of their own.
  const scale = o.videoScale ?? 1
  // A decoder serves one format of a clip (ADR 0027, 1): a film asking for both runs two.
  const keyOf = (file: string, format: VideoFormat) => `${file}\0${scale}\0${format}`
  const baked = (name: string) => {
    const frames = bakes[name]
    if (!frames)
      throw new Error(`No bake ${name} was checked for this host: is it in shaderera.json?`)
    return frames
  }
  const cacheDir = join(root, '.shaderera', 'cache')
  /** An entry's bytes, its use noted; null when there is none. */
  const cacheGet = async (hash: string) => {
    if (!ENTRY.test(hash)) throw new Error('A cache key is a sha256.')
    const file = join(cacheDir, hash)
    // An entry another process evicts as it is read is a miss: the film makes it again.
    let data: Buffer
    try {
      data = await readFile(file)
    } catch {
      return null
    }
    const now = new Date()
    await utimes(file, now, now).catch(() => {})
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  const cachePut = async (hash: string, bytes: Uint8Array) => {
    if (!ENTRY.test(hash)) throw new Error('A cache key is a sha256.')
    await mkdir(cacheDir, { recursive: true })
    const file = join(cacheDir, hash)
    // Written beside and moved, so another host never reads half of it. Hosts share this process,
    // so each put has a name of its own; one that loses the move to another put of the same entry
    // (same hash, same bytes; Windows refuses a move over a file being read) leaves that one.
    const part = `${file}.${randomUUID()}`
    await writeFile(part, bytes)
    try {
      await rename(part, file)
    } catch (e) {
      await rm(part, { force: true })
      if (!existsSync(file)) throw e
    }
    evict(cacheDir, limit, hash)
  }
  // This host, and the clips and stills it opened.
  const me = {}
  // The decoders this host uses, by key, and each one's file.
  const mine = new Map<string, string>()
  const myStills = new Set<string>()
  /**
   * A still's decoded RGBA (ADR 0028, 6–7): from the cache when it holds it, else decoded and kept
   * there. The entry is the raw bytes: its key names the size, and an entry of another length is
   * not used.
   */
  const still = async (
    key: string,
    bytes: Uint8Array,
    path: string,
    maxSize: number | undefined,
    size: { width: number; height: number; bits: 8 | 16 },
  ) => {
    const kept = await cacheGet(key)
    if (kept?.byteLength === size.width * size.height * 4 * (size.bits / 8)) return kept
    stillsDecoded.count++
    const data = await decodeStill(bytes, path, maxSize)
    await cachePut(key, data)
    return data
  }
  const openStill = async (path: string, maxSize?: number): Promise<StillSize> => {
    const bytes = new Uint8Array(await readFile(insideForRead(root, path)))
    const size = imageSize(bytes, path, maxSize)
    // Too large to keep (ADR 0028, 7): the hosts decode it, rather than this process holding a
    // copy for them all and sending it to each.
    if (size.width * size.height * 4 * (size.bits / 8) > limit / 8)
      return { ...size, key: '', local: true }
    decoderTag ??= sha256(IMAGE_WASM)
    const key = sha256(`${decoderTag}\0${sha256(bytes)}\0${size.width}x${size.height}x${size.bits}`)
    let s = stills.get(key)
    if (!s) {
      const made = { data: still(key, bytes, path, maxSize, size), users: new Set<object>() }
      // A failed decode is not kept: the next request tries again.
      made.data.catch(() => stills.get(key) === made && stills.delete(key))
      stills.set(key, made)
      s = made
    }
    s.users.add(me)
    myStills.add(key)
    await s.data
    return { ...size, key }
  }
  const closeStills = () => {
    for (const key of myStills) {
      const s = stills.get(key)
      s?.users.delete(me)
      if (s?.users.size === 0) stills.delete(key)
    }
    myStills.clear()
  }
  // The file each clip path named, checked once while the clip is open: the check reads the real
  // path of every folder above it, which on every frame cost the CLI's process more than the frame.
  const checked = new Map<string, string>()
  const video = (path: string, format: VideoFormat = 'rgba') => {
    let file = checked.get(path)
    if (file === undefined) {
      file = insideForRead(root, path)
      checked.set(path, file)
    }
    const key = keyOf(file, format)
    let v = shared.get(key)
    // A reader whose thread died is dropped: the next request opens a fresh one.
    if (v?.reader.dead) {
      shared.delete(key)
      v = undefined
    }
    if (!v) {
      const users = new Set<object>()
      // Two kept a host and one; decoded ahead, as many again (at most AHEAD_BYTES; ADR 0030).
      v = {
        users,
        reader: videoReader(
          file,
          () => 2 * users.size + 1,
          () => 2 * users.size + 1,
          undefined,
          scale,
          format,
        ),
      }
      shared.set(key, v)
    }
    v.users.add(me)
    mine.set(key, file)
    return v.reader
  }
  // Every format of the clip this host opened.
  const release = async (file: string) => {
    for (const [path, f] of checked) if (f === file) checked.delete(path)
    const done: Promise<void>[] = []
    for (const [key, f] of mine) {
      if (f !== file) continue
      mine.delete(key)
      const v = shared.get(key)
      v?.users.delete(me)
      if (v?.users.size === 0) {
        shared.delete(key)
        done.push(v.reader.dispose())
      }
    }
    await Promise.all(done)
  }
  const handle = async (r: ServiceRequest): Promise<unknown> => {
    switch (r.op) {
      case 'cache-get':
        return cacheGet(r.hash)
      case 'cache-put':
        await cachePut(r.hash, r.bytes)
        return null
      case 'image-open':
        return openStill(r.path, r.maxSize)
      case 'image-data': {
        const s = myStills.has(r.key) ? stills.get(r.key) : undefined
        if (!s) throw new Error('This host opened no such still.')
        return s.data
      }
      case 'video-open': {
        const { alpha: _, ...info } = video(r.path).info
        const file = checked.get(r.path) as string
        if (info.bits > 8) {
          const d = deepFootage.get(file)
          const declared = (d?.declared ?? true) && r.declared === true
          deepFootage.set(file, { at8: false, at10: false, ...d, bits: info.bits, declared })
        }
        return info
      }
      case 'video-frame': {
        const reader = video(r.path, r.format)
        const d = deepFootage.get(checked.get(r.path) as string)
        if (d) d[r.format === 'yuv420p10' ? 'at10' : 'at8'] = true
        return reader.frame(r.index)
      }
      case 'video-close':
        await release(insideForRead(root, r.path))
        return null
      case 'bake-open':
        return { frames: baked(r.name).length }
      case 'bake-frame': {
        const file = baked(r.name)[r.index]
        if (file === undefined || !Number.isInteger(r.index))
          throw new Error(
            `Bake ${r.name} has frames 0 to ${baked(r.name).length - 1}, not ${r.index}.`,
          )
        return new Uint8Array(readFileSync(file))
      }
    }
  }
  // close resolves once every decoder this host was the last user of has exited.
  return {
    handle,
    close: () => {
      closeStills()
      return Promise.all([...new Set(mine.values())].map(release)).then(() => {})
    },
  }
}
export type Services = ReturnType<typeof createServices>
