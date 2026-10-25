// What the hosts ask of the CLI's own process, which may write files and run ffmpeg where a
// project's code may not: the derived-data cache, decoded video frames and baked frames. The Node host asks
// over IPC (child.ts), the browser host's worker over the runner server (runner-plugin.ts).
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { extname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { insideForRead } from './inside.ts'
import type { FromVideo, ToVideo, VideoAsk } from './video-worker.ts'

/** The frames a host may read, by bake: absolute files, in order, checked against their stamps. */
export type BakeFrames = { readonly [name: string]: readonly string[] }

/** A request from a host. */
export type ServiceRequest =
  | { op: 'cache-get'; hash: string }
  | { op: 'cache-put'; hash: string; bytes: Uint8Array }
  | { op: 'video-open'; path: string }
  | { op: 'video-frame'; path: string; index: number }
  | { op: 'video-close'; path: string }
  | { op: 'bake-open'; name: string }
  | { op: 'bake-frame'; name: string; index: number }

export type VideoInfo = { width: number; height: number; fps: number; frames: number }

/**
 * A video's first stream as `io.video` gives it: width, height, fps, and the frames counted from
 * its packets (ffprobe).
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
      'stream=width,height,r_frame_rate,nb_read_packets',
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
  }
}

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
) => {
  const info = probeVideo(file)
  const worker = new Worker(new URL(`./video-worker${extname(import.meta.url)}`, import.meta.url), {
    workerData: { file, info },
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
    const a = asked.get(m.id)
    asked.delete(m.id)
    if (asked.size === 0) worker.unref()
    if (m.error !== undefined) a?.fail(new Error(m.error))
    else a?.done(m.bytes ?? null)
  })
  const gone = (error: Error) => {
    for (const a of asked.values()) a.fail(error)
    asked.clear()
  }
  worker.on('error', gone)
  worker.on('exit', () => gone(new Error(`The decoder of ${file} has stopped.`)))
  const ask = (m: VideoAsk) =>
    new Promise<Uint8Array | null>((done, fail) => {
      const id = next++
      asked.set(id, { done, fail })
      worker.ref()
      worker.postMessage({ ...m, id, keep: keep(), ahead: ahead() } as ToVideo)
    })
  return {
    info,
    frame: async (index: number) => (await ask({ type: 'frame', index })) as Uint8Array,
    /** Ends the decoder and drops what it decoded; the next frame starts another. */
    close: async () => {
      await ask({ type: 'close' })
    },
    /** Ends the decoder and its thread: the reader is not used again. */
    dispose: async () => {
      await ask({ type: 'close' })
      await worker.terminate()
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
 * re-check inspects after the next was asked for) is still there. It decodes a frame a host and one
 * ahead of the latest asked, so a host's next frame is usually there when it asks.
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

/** A cache entry's name: its key. Anything else there (a host's file being written) is not one. */
const ENTRY = /^[0-9a-f]{64}$/

/**
 * Removes the least recently used entries of a cache folder until it holds at most `limit` bytes,
 * never `keep` (the entry just put). An entry's modification time is its last use: a put writes
 * it and a get touches it. A file another host is writing (`<key>.<pid>`) is not an entry, and one
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
  o: { cacheLimit?: number } = {},
) => {
  const limit = o.cacheLimit ?? cacheLimit()
  const baked = (name: string) => {
    const frames = bakes[name]
    if (!frames)
      throw new Error(`No bake ${name} was checked for this host: is it in shaderera.json?`)
    return frames
  }
  const cacheDir = join(root, '.shaderera', 'cache')
  // This host, and the clips it opened.
  const me = {}
  const mine = new Set<string>()
  // The file each clip path named, checked once while the clip is open: the check reads the real
  // path of every folder above it, which on every frame cost the CLI's process more than the frame.
  const checked = new Map<string, string>()
  const video = (path: string) => {
    let file = checked.get(path)
    if (file === undefined) {
      file = insideForRead(root, path)
      checked.set(path, file)
    }
    let v = shared.get(file)
    if (!v) {
      const users = new Set<object>()
      // Two kept a host and one; decoded ahead, one a host and one.
      v = {
        users,
        reader: videoReader(
          file,
          () => 2 * users.size + 1,
          () => users.size + 1,
        ),
      }
      shared.set(file, v)
    }
    v.users.add(me)
    mine.add(file)
    return v.reader
  }
  const release = async (file: string) => {
    const v = shared.get(file)
    mine.delete(file)
    for (const [path, f] of checked) if (f === file) checked.delete(path)
    if (!v) return
    v.users.delete(me)
    if (v.users.size === 0) {
      shared.delete(file)
      await v.reader.dispose()
    }
  }
  const handle = async (r: ServiceRequest): Promise<unknown> => {
    switch (r.op) {
      case 'cache-get': {
        if (!/^[0-9a-f]{64}$/.test(r.hash)) throw new Error('A cache key is a sha256.')
        const file = join(cacheDir, r.hash)
        // An entry another process evicts as it is read is a miss: the film makes it again.
        let data: Buffer
        try {
          data = readFileSync(file)
        } catch {
          return null
        }
        try {
          const now = new Date()
          utimesSync(file, now, now)
        } catch {}
        return new Uint8Array(data)
      }
      case 'cache-put': {
        if (!/^[0-9a-f]{64}$/.test(r.hash)) throw new Error('A cache key is a sha256.')
        mkdirSync(cacheDir, { recursive: true })
        const file = join(cacheDir, r.hash)
        // Written beside and moved, so another host never reads half of it.
        writeFileSync(`${file}.${process.pid}`, r.bytes)
        renameSync(`${file}.${process.pid}`, file)
        evict(cacheDir, limit, r.hash)
        return null
      }
      case 'video-open':
        return video(r.path).info
      case 'video-frame':
        return video(r.path).frame(r.index)
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
  return { handle, close: () => Promise.all([...mine].map(release)).then(() => {}) }
}
export type Services = ReturnType<typeof createServices>
