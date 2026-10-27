// The decoder behind `io.video` (services.ts), run in a thread of its own (video-worker.ts).
import { spawn } from 'node:child_process'
import type { VideoInfo } from './services.ts'
import { type SpawnTurn, spawnInTurn } from './spawn-turn.ts'

/** How io.video hands a frame over (ADR 0027): straight RGBA, or the file's Y'CbCr planes (I420). */
export type VideoFormat = 'rgba' | 'yuv420p'

/** A frame's bytes in `format` at `width` × `height`. */
export const frameBytes = (format: VideoFormat, width: number, height: number) =>
  format === 'yuv420p'
    ? width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2)
    : width * height * 4

/**
 * Where a file's frames are, for a decoder that starts near a frame instead of at frame 0: each
 * frame's pts in presentation order (frame i is `pts[i]`), the frames a decode may start at, and
 * the file's start time, from its packets (ffprobe reads them, decoding nothing). Null when the
 * packets cannot say which frame is which: a codec whose packets are not one frame each, a packet
 * without a pts, two packets with one pts.
 */
export type FrameIndex = {
  pts: bigint[]
  /** The frames a decode may start at (keyframes), ascending. */
  keys: number[]
  timeBase: [bigint, bigint]
  /** The file's start time in microseconds: ffmpeg's `-ss` counts from it. */
  startUs: bigint
}

/** Codecs whose packets are one frame each, so the n-th frame decoded is the n-th packet by pts. */
const ONE_FRAME_A_PACKET = new Set(['h264', 'hevc', 'prores', 'dnxhd', 'mjpeg'])

/** Reads ffprobe's packets of the first video stream (`-of json`) into a FrameIndex, or null. */
export const frameIndex = (json: string): FrameIndex | null => {
  const p = JSON.parse(json) as {
    packets?: { pts?: number | string; flags?: string }[]
    streams?: { codec_name?: string; time_base?: string }[]
    format?: { start_time?: string }
  }
  const s = p.streams?.[0]
  if (!s || !ONE_FRAME_A_PACKET.has(String(s.codec_name))) return null
  const [num, den] = String(s.time_base).split('/')
  const start = /^(-?)(\d+)\.(\d{6})$/.exec(String(p.format?.start_time))
  if (!num || !den || !/^\d+$/.test(num) || !/^\d+$/.test(den) || !start) return null
  const frames: { pts: bigint; key: boolean }[] = []
  for (const k of p.packets ?? []) {
    // A packet an edit list discards (`D`) is decoded for the frames after it, never given.
    if (k.flags?.includes('D')) continue
    if (k.pts === undefined || !/^-?\d+$/.test(String(k.pts))) return null
    frames.push({ pts: BigInt(k.pts), key: k.flags?.[0] === 'K' })
  }
  frames.sort((a, b) => (a.pts < b.pts ? -1 : a.pts > b.pts ? 1 : 0))
  for (let i = 1; i < frames.length; i++)
    if ((frames[i] as { pts: bigint }).pts === (frames[i - 1] as { pts: bigint }).pts) return null
  const startUs = BigInt(`${start[2]}${start[3]}`) * (start[1] ? -1n : 1n)
  return {
    pts: frames.map((f) => f.pts),
    keys: frames.flatMap((f, i) => (f.key ? [i] : [])),
    timeBase: [BigInt(num), BigInt(den)],
    startUs,
  }
}

/**
 * Where a decode for frame `from` starts: the `-ss` (seconds after the file's start) of the last
 * keyframe at or before it, and that keyframe. Undefined when it would start at the file's start
 * anyway (or `from` is past what the index knows).
 */
export const seekFor = (
  index: FrameIndex,
  from: number,
): { ss: string; key: number } | undefined => {
  if (from <= 0 || from >= index.pts.length) return undefined
  // The last keyframe at or before `from` (frames are in pts order, so by index).
  let lo = 0
  let hi = index.keys.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((index.keys[mid] as number) <= from) lo = mid + 1
    else hi = mid
  }
  const key = index.keys[lo - 1]
  if (key === undefined || key === 0) return undefined
  const [num, den] = index.timeBase
  // Rounded down to a microsecond, so ffmpeg's seek lands on this keyframe or one before it.
  const at = (index.pts[key] as bigint) * num * 1_000_000n
  const us = (at >= 0n ? at / den : -((-at + den - 1n) / den)) - index.startUs
  if (us <= 0n) return undefined
  return { ss: `${us / 1_000_000n}.${String(us % 1_000_000n).padStart(6, '0')}`, key }
}

/**
 * The longest stretch, in seconds, a decode starts before the frame it wants: from the first frame
 * to the first keyframe, from a keyframe to the next, or from the last one to the last frame. A
 * seek into a file decodes up to that much.
 */
export const keyGap = (index: FrameIndex): number => {
  const at = [0, ...index.keys, index.pts.length - 1]
  let most = 0n
  for (let i = 1; i < at.length; i++) {
    const d = (index.pts[at[i] as number] as bigint) - (index.pts[at[i - 1] as number] as bigint)
    if (d > most) most = d
  }
  const [num, den] = index.timeBase
  return Number(most * num) / Number(den)
}

/** The packets of `file`'s first video stream, read by ffprobe in the thread's turn. */
export const probeIndex = (file: string, turn?: SpawnTurn) =>
  new Promise<FrameIndex | null>((done) => {
    const args = [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,time_base:format=start_time:packet=pts,flags',
      '-of',
      'json',
      file,
    ]
    const p = spawnInTurn(turn, () =>
      spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'ignore'] }),
    )
    const out: Buffer[] = []
    p.stdout?.on('data', (d: Buffer) => out.push(d))
    p.on('error', () => done(null))
    p.on('close', (code) => {
      try {
        done(code === 0 ? frameIndex(Buffer.concat(out).toString('utf8')) : null)
      } catch {
        done(null)
      }
    })
  })

/** `n` bytes in a buffer of their own, not zeroed: they are written whole before they are read. */
const bytes = (n: number) => new Uint8Array(Buffer.allocUnsafeSlow(n).buffer as ArrayBuffer, 0, n)

/**
 * Decodes one file's frames in order with ffmpeg. The last `keep()` frames up to the latest asked
 * are kept, so a frame asked a little out of order is given again without decoding; one before
 * them restarts it, as does one far ahead. The decoder runs up to `ahead()` frames past the latest
 * asked (`keep()` by default), so the next frames are decoded while the hosts render, not when
 * they ask. Each frame is given as bytes of its own, a copy of the kept one.
 *
 * A restart at a frame past the first starts ffmpeg at the keyframe before it (`-ss` before `-i`),
 * not at frame 0 (#434): the file's packets (`frameIndex`) say which pts frame i has, and each frame
 * that comes out is given as frame i only once its pts (showinfo, with `-copyts`) is the one frame
 * i has. A file the packets cannot index, or a frame that comes out with another pts or not at all,
 * goes back to decoding from frame 0 and counting, as before; that file is not seeked again. A
 * seeked decoder runs on 4 threads, which cuts the decode up to the frame (the same bytes as one
 * thread: ffmpeg's frame threads are exact).
 */
export const videoDecoder = (
  file: string,
  /**
   * `scaled`: the frames at `width` × `height`, not the file's own size (a draft's, scaledVideo).
   * `format`: straight RGBA (the default), or the file's planes as `yuv420p` in `info.colour`.
   */
  info: VideoInfo & { scaled?: boolean; format?: VideoFormat },
  keep: () => number = () => 1,
  ahead: () => number = keep,
  /** The thread's turns to start ffmpeg in (spawn-turn.ts); none in the CLI's own thread. */
  turn?: SpawnTurn,
  /** For tests: the frame index in place of the one read from the file. */
  known?: FrameIndex | null,
) => {
  const size = frameBytes(info.format ?? 'rgba', info.width, info.height)
  let proc: ReturnType<typeof spawn> | undefined
  // The index of the frame being filled, its bytes and how many came.
  let next = 0
  let filling: Uint8Array | undefined
  let filled = 0
  // Decoded frames, in order and without gaps: the kept ones and the ones decoded ahead.
  let frames: { index: number; bytes: Uint8Array }[] = []
  // The latest frame asked since the decoder started.
  let asked = 0
  let waiting: (() => void) | undefined
  let ended = false
  // Why the decoder could not start (no ffmpeg): every read of it fails with it.
  let failed: Error | undefined
  // The file's frames by pts: not read yet, or null once the file is not to be seeked.
  let packets: FrameIndex | null | undefined = known
  // Its longest keyframe gap, worked out once for the packets read.
  let gapOf: FrameIndex | null | undefined
  let gap: number | undefined
  // A seeked decoder's frames before `checked` came out with the pts they should have: only those
  // are given. A decoder from frame 0 counts its frames: all are.
  let checked = Number.POSITIVE_INFINITY
  // A seeked decoder gave a frame with a pts not its own, or ended early: it is not used.
  let wrong = false
  // Buffers of frames dropped, filled again by the next frames (#464): a new 33 MB buffer for each
  // 4K frame cost more than the copy into it. Frames are given as copies, so none is still in use.
  const spare: Uint8Array[] = []
  const trim = () => {
    const oldest = asked - Math.max(1, keep()) + 1
    while ((frames[0]?.index ?? oldest) < oldest) {
      const dropped = (frames.shift() as { bytes: Uint8Array }).bytes
      if (spare.length < 2) spare.push(dropped)
    }
  }
  // Decoded far enough past the latest asked: ffmpeg waits until a host catches up.
  const full = () => next - 1 - asked >= Math.max(1, ahead())
  // A draft's clip comes at its own size, scaled in the same swscale pass as the conversion.
  const resize = info.scaled ? `w=${info.width}:h=${info.height}:flags=area:` : ''
  // RGBA: converted by the file's own colour tags. yuv420p (ADR 0027, 1): the file's matrix, range
  // and siting, named so swscale keeps them; an 8-bit 4:2:0 file passes through unconverted.
  const { matrix, range, chroma } = info.colour
  const convert =
    info.format === 'yuv420p'
      ? `out_color_matrix=${matrix === 'bt2020nc' ? 'bt2020' : matrix}:out_range=${range === 'full' ? 'pc' : 'tv'}:out_chroma_loc=${chroma},format=yuv420p`
      : 'in_color_matrix=auto:in_range=auto:out_range=full,format=rgba'
  const start = (from: number) => {
    proc?.kill()
    const seek = packets ? seekFor(packets, from) : undefined
    // Software decode, every frame from `from` on, converted by the file's own colour tags, started
    // in this thread's turn. Seeked: ffmpeg starts at a keyframe before `from`, keeps the file's
    // timestamps and picks frames by pts, printing each one's pts (showinfo) to check it.
    const pick = seek
      ? `select=gte(pts\\,${(packets as FrameIndex).pts[from]}),showinfo=checksum=0`
      : `select=gte(n\\,${from})`
    const args = [
      '-loglevel',
      seek ? 'info' : 'error',
      '-threads',
      seek ? '4' : '1',
      ...(seek ? ['-nostats', '-ss', seek.ss, '-noaccurate_seek', '-copyts'] : []),
      '-i',
      file,
      '-map',
      '0:v:0',
      '-vf',
      `${pick},scale=${resize}${convert}`,
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-',
    ]
    proc = spawnInTurn(turn, () =>
      spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', seek ? 'pipe' : 'ignore'] }),
    )
    next = from
    asked = from
    frames = []
    filling = undefined
    filled = 0
    ended = false
    failed = undefined
    checked = seek ? from : Number.POSITIVE_INFINITY
    wrong = false
    // Events of a decoder that was replaced (a jump back) are ignored.
    const mine = proc
    mine.on('error', (error) => {
      if (proc !== mine) return
      failed = new Error(`ffmpeg could not decode ${file}: ${error.message}`)
      ended = true
      waiting?.()
    })
    mine.stdout?.on('data', (d: Buffer) => {
      if (proc !== mine) return
      // Copied once, into the frame's own buffer, as the bytes come.
      for (let at = 0; at < d.length; ) {
        filling ??= spare.pop() ?? bytes(size)
        const n = Math.min(size - filled, d.length - at)
        filling.set(d.subarray(at, at + n), filled)
        filled += n
        at += n
        if (filled === size) {
          frames.push({ index: next++, bytes: filling })
          filling = undefined
          filled = 0
        }
      }
      trim()
      if (full()) mine.stdout?.pause()
      waiting?.()
    })
    // Seeked, it has ended once both its pipes have (the last pts may come after the last bytes).
    let open = seek ? 2 : 1
    const end = () => {
      if (proc !== mine || --open > 0) return
      ended = true
      waiting?.()
    }
    mine.stdout?.on('end', end)
    if (seek && mine.stderr) {
      const pts = (packets as FrameIndex).pts
      let line = ''
      mine.stderr.setEncoding('utf8')
      mine.stderr.on('data', (d: string) => {
        if (proc !== mine) return
        line += d
        const lines = line.split('\n')
        line = lines.pop() ?? ''
        for (const l of lines) {
          const m = /\bn:\s*\d+\s+pts:\s*(-?\d+)/.exec(l)
          if (!m || wrong) continue
          if (BigInt(m[1] as string) === pts[checked]) checked++
          else wrong = true
        }
        waiting?.()
      })
      mine.stderr.on('end', end)
    }
  }
  // Starts a decoder at `from`, reading the file's packets first the first time it starts past
  // frame 0.
  const begin = async (from: number) => {
    if (from > 0 && packets === undefined) packets = await probeIndex(file, turn)
    start(from)
  }
  const read = async (index: number): Promise<Uint8Array<ArrayBuffer>> => {
    if (!Number.isInteger(index) || index < 0 || index >= info.frames)
      throw new Error(`${file} has frames 0 to ${info.frames - 1}, not ${index}.`)
    // A jump far ahead restarts the decoder: a new one decodes from where it starts (the keyframe
    // before `index`, or frame 0) and skips the frames before `index` inside ffmpeg, where this one
    // would convert and pipe every one of them. Decoding is about a third of that work, so the
    // restart is cheaper when it decodes less than three times the frames this one would read on.
    if (proc && index - next > 30) {
      if (packets === undefined) packets = await probeIndex(file, turn)
      const from = (packets && seekFor(packets, index)?.key) || 0
      if (index - from < 3 * (index - next)) await begin(index)
    }
    // Raised and trimmed first, so the frames looked in are the ones kept from now on (a `keep()`
    // that shrank since, a host gone, drops some).
    asked = Math.max(asked, index)
    trim()
    for (;;) {
      if (!proc) await begin(index)
      const found = frames.find((f) => f.index === index)
      if (found && index < checked) {
        if (!full()) proc?.stdout?.resume()
        // A copy of its own: the kept one's buffer is filled again once it is dropped.
        const copy = bytes(size)
        copy.set(found.bytes)
        return copy
      }
      // A seeked decoder that gave another frame than the one it should, or ended before this one
      // (not one it ended past, at the file's end, and a jump back now asks for): the file is
      // decoded from frame 0 from now on, as it always was.
      const behind = index < (frames[0]?.index ?? next)
      if (checked !== Number.POSITIVE_INFINITY && (wrong || (ended && !failed && !behind))) {
        packets = null
        await begin(index)
        continue
      }
      // Behind what is kept (a jump back) or behind where it decodes: only a new decoder reaches
      // it, never this one reading on.
      if (behind) {
        await begin(index)
        continue
      }
      if (failed) throw failed
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
    frames = []
    filling = undefined
    filled = 0
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
    frame: (index: number) => inTurn(() => read(index)),
    close: () => inTurn(stop),
    /** The decoder's process id, while one runs. */
    get pid() {
      return proc?.pid
    },
    /** The file's longest keyframe gap (keyGap), once its packets were read to seek. */
    get keyGap() {
      if (gapOf !== packets) {
        gapOf = packets
        gap = packets ? keyGap(packets) : undefined
      }
      return gap
    },
    /** Whether the decoder running now started near its first frame (`-ss`), not at frame 0. */
    get seeked() {
      return proc !== undefined && checked !== Number.POSITIVE_INFINITY
    },
  }
}
