// What the hosts ask of the CLI's own process, which may write files and run ffmpeg where a
// project's code may not: the derived-data cache and decoded video frames. The Node host asks
// over IPC (child.ts), the browser host's worker over the runner server (runner-plugin.ts).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { insideForRead } from './inside.ts'

/** A request from a host. */
export type ServiceRequest =
  | { op: 'cache-get'; hash: string }
  | { op: 'cache-put'; hash: string; bytes: Uint8Array }
  | { op: 'video-open'; path: string }
  | { op: 'video-frame'; path: string; index: number }

type VideoInfo = { width: number; height: number; fps: number; frames: number }

/** Decodes one file's frames in order with ffmpeg; a frame before the last one read restarts it. */
const videoReader = (file: string) => {
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
  if (r.status !== 0) throw new Error(`ffprobe cannot read ${file}: ${r.stderr.trim()}`)
  const s = (JSON.parse(r.stdout) as { streams: { [k: string]: string | number }[] }).streams[0]
  if (!s) throw new Error(`${file} has no video stream.`)
  const [n, d] = String(s.r_frame_rate).split('/').map(Number)
  const info: VideoInfo = {
    width: Number(s.width),
    height: Number(s.height),
    fps: d ? (n as number) / d : (n as number),
    frames: Number(s.nb_read_packets),
  }
  const size = info.width * info.height * 4
  let proc: ReturnType<typeof spawn> | undefined
  let next = 0
  // The decoded bytes not taken yet, joined once per frame.
  let chunks: Buffer[] = []
  let bytes = 0
  let waiting: (() => void) | undefined
  let ended = false
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
    if (!proc || index < next) start(index)
    for (;;) {
      while (bytes >= size) {
        const out = take()
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
  // One request at a time: they share the decoder.
  let queue: Promise<unknown> = Promise.resolve()
  const frame = (index: number): Promise<Uint8Array> => {
    const result = queue.then(() => read(index))
    queue = result.catch(() => {})
    return result
  }
  return { info, frame, close: () => proc?.kill() }
}

/** The services for one project: answers each request, or throws. */
export const createServices = (root: string) => {
  const cacheDir = join(root, '.shaderera', 'cache')
  const videos = new Map<string, ReturnType<typeof videoReader>>()
  const video = (path: string) => {
    const file = insideForRead(root, path)
    let v = videos.get(file)
    if (!v) {
      v = videoReader(file)
      videos.set(file, v)
    }
    return v
  }
  const handle = async (r: ServiceRequest): Promise<unknown> => {
    switch (r.op) {
      case 'cache-get': {
        if (!/^[0-9a-f]{64}$/.test(r.hash)) throw new Error('A cache key is a sha256.')
        const file = join(cacheDir, r.hash)
        return existsSync(file) ? new Uint8Array(readFileSync(file)) : null
      }
      case 'cache-put': {
        if (!/^[0-9a-f]{64}$/.test(r.hash)) throw new Error('A cache key is a sha256.')
        mkdirSync(cacheDir, { recursive: true })
        const file = join(cacheDir, r.hash)
        // Written beside and moved, so another host never reads half of it.
        writeFileSync(`${file}.${process.pid}`, r.bytes)
        renameSync(`${file}.${process.pid}`, file)
        return null
      }
      case 'video-open':
        return video(r.path).info
      case 'video-frame':
        return video(r.path).frame(r.index)
    }
  }
  return { handle, close: () => videos.forEach((v) => void v.close()) }
}
export type Services = ReturnType<typeof createServices>
