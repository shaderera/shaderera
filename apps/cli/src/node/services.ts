// What the hosts ask of the CLI's own process, which may write files and run ffmpeg where a
// project's code may not: the derived-data cache, decoded video frames and baked frames. The Node host asks
// over IPC (child.ts), the browser host's worker over the runner server (runner-plugin.ts).
import { spawn, spawnSync } from 'node:child_process'
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
import { join } from 'node:path'
import { insideForRead } from './inside.ts'

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
 * Decodes one file's frames in order with ffmpeg. The last `keep()` frames decoded are kept, so a
 * frame asked a little out of order is given again without decoding; one before them restarts it.
 */
export const videoReader = (file: string, keep: () => number = () => 1) => {
  const info = probeVideo(file)
  const size = info.width * info.height * 4
  let proc: ReturnType<typeof spawn> | undefined
  let next = 0
  // The decoded bytes not taken yet, joined once per frame.
  let chunks: Buffer[] = []
  let bytes = 0
  let waiting: (() => void) | undefined
  let ended = false
  let ring: { index: number; bytes: Uint8Array }[] = []
  const start = (from: number) => {
    proc?.kill()
    // Software decode, every frame from `from` on, converted by the file's own colour tags.
    proc = spawn(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-threads',
        '1',
        '-i',
        file,
        '-map',
        '0:v:0',
        '-vf',
        `select=gte(n\\,${from}),scale=in_color_matrix=auto:in_range=auto:out_range=full,format=rgba`,
        '-fps_mode',
        'passthrough',
        '-f',
        'rawvideo',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    next = from
    chunks = []
    bytes = 0
    ended = false
    // Events of a decoder that was replaced (a jump back) are ignored.
    const mine = proc
    mine.stdout?.on('data', (d: Buffer) => {
      if (proc !== mine) return
      chunks.push(d)
      bytes += d.length
      // A frame is held: ffmpeg waits until the next one is asked for.
      if (bytes >= size) mine.stdout?.pause()
      waiting?.()
    })
    mine.stdout?.on('end', () => {
      if (proc !== mine) return
      ended = true
      waiting?.()
    })
  }
  const take = () => {
    const all = Buffer.concat(chunks, bytes)
    chunks = bytes > size ? [all.subarray(size)] : []
    bytes -= size
    return new Uint8Array(all.subarray(0, size))
  }
  const read = async (index: number): Promise<Uint8Array> => {
    if (!Number.isInteger(index) || index < 0 || index >= info.frames)
      throw new Error(`${file} has frames 0 to ${info.frames - 1}, not ${index}.`)
    const kept = ring.find((f) => f.index === index)
    if (kept) return kept.bytes
    if (!proc || index < next) start(index)
    for (;;) {
      while (bytes >= size) {
        const out = take()
        ring = [{ index: next, bytes: out }, ...ring].slice(0, Math.max(1, keep()))
        if (next++ === index) return out
      }
      if (ended) throw new Error(`${file} ended before frame ${index}.`)
      proc?.stdout?.resume()
      await new Promise<void>((done) => {
        waiting = done
      })
      waiting = undefined
    }
  }
  // Ends the decoder and drops what it decoded; the next read starts another.
  const stop = async () => {
    const mine = proc
    proc = undefined
    ring = []
    chunks = []
    bytes = 0
    if (!mine || mine.exitCode !== null || mine.signalCode !== null) return
    const exited = new Promise((done) => mine.once('exit', done))
    mine.kill()
    await exited
  }
  // One request at a time: they share the decoder.
  let queue: Promise<unknown> = Promise.resolve()
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    const result = queue.then(run)
    queue = result.catch(() => {})
    return result
  }
  return {
    info,
    frame: (index: number) => inTurn(() => read(index)),
    close: () => inTurn(stop),
    /** The decoder's process id, while one runs. */
    get pid() {
      return proc?.pid
    },
  }
}

/**
 * The clips open in this process, each with the hosts using it. Several hosts of one render ask
 * frames in turn, so one decoder serves them all, keeping two frames a host and one: a frame is
 * decoded once, not once a host, and one asked a little late (another host's, or the frame a
 * re-check inspects after the next was asked for) is still there.
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
  const video = (path: string) => {
    const file = insideForRead(root, path)
    let v = shared.get(file)
    if (!v) {
      const users = new Set<object>()
      v = { users, reader: videoReader(file, () => 2 * users.size + 1) }
      shared.set(file, v)
    }
    v.users.add(me)
    mine.add(file)
    return v.reader
  }
  const release = async (file: string) => {
    const v = shared.get(file)
    mine.delete(file)
    if (!v) return
    v.users.delete(me)
    if (v.users.size === 0) {
      shared.delete(file)
      await v.reader.close()
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
