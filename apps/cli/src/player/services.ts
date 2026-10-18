// What the CLI's process answers for a film (io.video, io.cache, io.bake), answered in the web
// player's worker instead: a static player has no CLI behind it. player/worker.ts hands it to the
// runner (configureRunner), with the same answers as node/services.ts.
//
// io.video reads the proxy the build made (media/<path>.mp4, with the original's info in
// media/<path>.json) and decodes it with WebCodecs, through Mediabunny. Frame i is straight,
// full-range RGBA, as the CLI hands it over; the browser's decoder and colour conversion make it
// close to ffmpeg's, not the same bytes. io.bake reads the frames the build copied to
// bakes/<name>/, the same bytes as the CLI's. io.cache is kept in memory.
//
// A clip may also be one of the viewer's own files, `local:<id>/<name>`: the framing page hands
// the File to the player's bridge, the bridge to this worker (docs/player.md), and io.video
// decodes it here, its info read from the file itself. It never leaves the viewer's machine.
import {
  ALL_FORMATS,
  BlobSource,
  BufferSource,
  Input,
  type InputVideoTrack,
  type VideoSample,
  VideoSampleSink,
} from 'mediabunny'
import type { Ask } from '../runner/io.ts'

type Info = { width: number; height: number; fps: number; frames: number }

/** How far ahead a read decodes on rather than seeking: about a proxy's keyframe interval. */
const AHEAD = 15
/** How long io.video waits for a local file to arrive from the page. */
const FILE_WAIT_MS = 10_000

type Clip = {
  info: Info
  first: number
  sink: VideoSampleSink
  input: Input
  /** The samples from the last seek on, and the index of the next one they give. */
  reading?: AsyncGenerator<VideoSample, void, unknown>
  next: number
}

const fetchBytes = async (url: URL, what: string) => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${what}: ${r.status}`)
  return new Uint8Array(await r.arrayBuffer())
}

/** A track the browser can decode, or an error naming why not. */
const decodable = async (input: Input, what: string): Promise<InputVideoTrack> => {
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error(`${what} has no video track.`)
  if (!(await track.canDecode()))
    throw new Error(`This browser cannot decode ${what} (${track.codec ?? 'its codec'}).`)
  return track
}

/** Straight RGBA, 4 bytes a pixel, full range, sRGB: what the CLI's ffmpeg hands over. */
const rgba = async (sample: VideoSample, info: Info): Promise<Uint8Array> => {
  const out = new Uint8Array(info.width * info.height * 4)
  try {
    await sample.copyTo(out, { format: 'RGBA', colorSpace: 'srgb' })
    return out
  } catch {
    // A browser without copyTo's conversion: through a canvas, which converts the same way.
    const canvas = new OffscreenCanvas(info.width, info.height)
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb' }) as OffscreenCanvasRenderingContext2D
    sample.draw(ctx, 0, 0, info.width, info.height)
    return new Uint8Array(ctx.getImageData(0, 0, info.width, info.height).data.buffer)
  }
}

/**
 * The player's answers, for the film whose files are at `files` (an absolute URL ending in `/`,
 * beside `media/` and `bakes/`), and `localFile`, which gives a viewer's file by its `local:` name.
 */
export const playerAsk = (files: string, localFile: (name: string) => Blob | undefined): Ask => {
  const clips = new Map<string, Promise<Clip>>()
  const bakes = new Map<string, Promise<string[]>>()
  const cache = new Map<string, Uint8Array>()

  const waitForFile = async (name: string): Promise<Blob> => {
    for (const start = Date.now(); Date.now() - start < FILE_WAIT_MS; ) {
      const file = localFile(name)
      if (file) return file
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`io.video(${name}): the page did not hand this file to the player.`)
  }

  const open = async (path: string): Promise<Clip> => {
    if (path.startsWith('local:')) {
      const name = path.slice(path.indexOf('/') + 1)
      const input = new Input({
        source: new BlobSource(await waitForFile(path)),
        formats: ALL_FORMATS,
      })
      const track = await decodable(input, name)
      const stats = await track.computePacketStats()
      return {
        info: {
          width: track.displayWidth,
          height: track.displayHeight,
          fps: stats.averagePacketRate,
          frames: stats.packetCount,
        },
        first: await track.getFirstTimestamp(),
        sink: new VideoSampleSink(track),
        input,
        next: 0,
      }
    }
    const media = new URL(`../media/${path.replace(/^\.?\//, '')}`, files)
    const info = (await (await fetch(`${media.href}.json`)).json().catch(() => null)) as Info | null
    if (!info)
      throw new Error(
        `io.video(${path}): not a video of this film (the player has no proxy for it).`,
      )
    const input = new Input({
      source: new BufferSource(await fetchBytes(new URL(`${media.href}.mp4`), `io.video(${path})`)),
      formats: ALL_FORMATS,
    })
    const track = await decodable(input, `io.video(${path})'s proxy`)
    return {
      info,
      first: await track.getFirstTimestamp(),
      sink: new VideoSampleSink(track),
      input,
      next: 0,
    }
  }

  const clipOf = (path: string) => {
    let clip = clips.get(path)
    if (!clip) {
      clip = open(path)
      clip.catch(() => clips.delete(path))
      clips.set(path, clip)
    }
    return clip
  }

  const frame = async (clip: Clip, index: number): Promise<Uint8Array> => {
    const { info } = clip
    if (!Number.isInteger(index) || index < 0 || index >= info.frames)
      throw new Error(`The clip has frames 0 to ${info.frames - 1}, not ${index}.`)
    // Behind, or far ahead: seek, which decodes from the keyframe before frame i.
    if (!clip.reading || index < clip.next || index > clip.next + AHEAD) {
      await clip.reading?.return()
      // Half a frame in, so a timestamp's rounding never lands on the frame before.
      clip.reading = clip.sink.samples(clip.first + (index + 0.5) / info.fps)
      clip.next = index
    }
    for (;;) {
      const { value, done } = await clip.reading.next()
      if (done) throw new Error(`The clip ended before frame ${index}.`)
      if (clip.next++ < index) {
        value.close()
        continue
      }
      try {
        return await rgba(value, info)
      } finally {
        value.close()
      }
    }
  }

  const bakeOf = (name: string) => {
    let frames = bakes.get(name)
    if (!frames) {
      frames = fetch(new URL(`../bakes/${encodeURIComponent(name)}.json`, files)).then(
        async (r) => {
          if (!r.ok) throw new Error(`io.bake(${name}): this player has no bake ${name}.`)
          return ((await r.json()) as { frames: string[] }).frames
        },
      )
      frames.catch(() => bakes.delete(name))
      bakes.set(name, frames)
    }
    return frames
  }

  return {
    cacheGet: async (hash) => cache.get(hash) ?? null,
    cachePut: async (hash, bytes) => void cache.set(hash, bytes),
    videoOpen: async (path) => (await clipOf(path)).info,
    videoFrame: async (path, index) => frame(await clipOf(path), index),
    videoClose: async (path) => {
      const clip = clips.get(path)
      clips.delete(path)
      const c = await clip?.catch(() => undefined)
      await c?.reading?.return()
      c?.input.dispose()
    },
    bakeOpen: async (name) => ({ frames: (await bakeOf(name)).length }),
    bakeFrame: async (name, index) => {
      const frames = await bakeOf(name)
      const file = frames[index]
      if (file === undefined || !Number.isInteger(index))
        throw new Error(`Bake ${name} has frames 0 to ${frames.length - 1}, not ${index}.`)
      return fetchBytes(
        new URL(`../bakes/${encodeURIComponent(name)}/${encodeURIComponent(file)}`, files),
        `io.bake(${name})`,
      )
    },
  }
}
