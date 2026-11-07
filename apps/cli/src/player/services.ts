// What the CLI's process answers for a film (io.image, io.video, io.cache, io.bake), answered in the web
// player's worker instead: a static player has no CLI behind it. player/worker.ts hands it to the
// runner (configureRunner), with the same answers as node/services.ts.
//
// io.image decodes the film's file from files/ with the same module as the CLI (runner/image.ts),
// so the same bytes.
//
// io.video reads the proxy the build made (media/<path>.mp4, with the original's info in
// media/<path>.json) and decodes it with WebCodecs, through Mediabunny. Frame i is straight,
// full-range RGBA, as the CLI hands it over; the browser's decoder and colour conversion make it
// close to ffmpeg's, not the same bytes. As yuv420p it is the proxy's own planes (BT.709 limited,
// the chroma sited left), as I420: close to the CLI's planes of the original, not the same. As
// yuv420p10 it is those planes shifted up two bits (ADR 0031, 4): the 8-bit proxy's codes, which
// band where the original's 10 bits would not. A clip asked smaller (`maxSize`, #507) is decoded at
// the proxy's size and shrunk here, each plane or the RGBA by area average in integers (`shrink`),
// the same bytes every time.
// io.bake reads the frames the build copied to bakes/<name>/, the same bytes as the CLI's.
// io.cache is kept in memory.
//
// A clip may also be one of the viewer's own files, `local:<id>/<name>`: the framing page hands
// the File to the player's bridge, the bridge to this worker (docs/player.md), and io.video
// decodes it here, its info read from the file itself. It never leaves the viewer's machine.
import type { VideoColour } from '@shaderera/core'
import {
  ALL_FORMATS,
  BlobSource,
  BufferSource,
  Input,
  type InputVideoTrack,
  type VideoSample,
  VideoSampleSink,
} from 'mediabunny'
import { decodeImage } from '../runner/image.ts'
import { type Ask, fitSize } from '../runner/io.ts'

type Info = {
  width: number
  height: number
  fps: number
  frames: number
  /** The original's sample depth, not the proxy's. */
  bits: 8 | 10 | 12 | 16
  colour: VideoColour
  /** The original's pixel format carries alpha (node/services.ts probeVideo): no planes. */
  alpha?: boolean
}

/** The proxy's planes (media.ts makeProxy). */
const PROXY: VideoColour = { matrix: 'bt709', range: 'limited', chroma: 'left' }

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
 * The decoder's planes as I420, tight (ADR 0027, 1): Y, then Cb, then Cr. NV12 (Cb and Cr
 * interleaved) is split; any other format (with alpha, more than 8 bits) is refused. `ten`: as
 * `yuv420p10` (ADR 0031), 16-bit little-endian samples, 8-bit planes shifted up two bits and a
 * viewer's own 10-bit file's (I420P10) as they are.
 */
const i420 = async (
  sample: VideoSample,
  info: Info,
  what: string,
  ten: boolean,
): Promise<Uint8Array> => {
  const deep = ten && sample.format === 'I420P10'
  if (info.alpha || (sample.format !== 'I420' && sample.format !== 'NV12' && !deep))
    throw new Error(
      `${what} decodes as ${info.alpha ? 'a format with alpha' : sample.format}, not ${ten ? 'yuv420p10' : 'yuv420p'}: ask for its frames as rgba.`,
    )
  const { width: w, height: h } = info
  const cw = Math.ceil(w / 2)
  const ch = Math.ceil(h / 2)
  // Bytes a sample.
  const n = deep ? 2 : 1
  const raw = new Uint8Array(sample.allocationSize())
  const [y, u, v] = await sample.copyTo(raw)
  const out = new Uint8Array((w * h + 2 * cw * ch) * n)
  const rows = (p: PlaneLayout, width: number, height: number, at: number) => {
    for (let r = 0; r < height; r++)
      out.set(
        raw.subarray(p.offset + r * p.stride, p.offset + r * p.stride + width * n),
        (at + r * width) * n,
      )
  }
  rows(y as PlaneLayout, w, h, 0)
  if (sample.format !== 'NV12') {
    rows(u as PlaneLayout, cw, ch, w * h)
    rows(v as PlaneLayout, cw, ch, w * h + cw * ch)
  } else {
    const p = u as PlaneLayout
    for (let r = 0; r < ch; r++)
      for (let c = 0; c < cw; c++) {
        out[w * h + r * cw + c] = raw[p.offset + r * p.stride + 2 * c] as number
        out[w * h + cw * ch + r * cw + c] = raw[p.offset + r * p.stride + 2 * c + 1] as number
      }
  }
  if (!ten || deep) return out
  return new Uint8Array(Uint16Array.from(out, (s) => s << 2).buffer)
}

/**
 * For each of `m` samples along a line of `n`, the first source sample under it and the length
 * each covers, in units of 1/(n × m) of the line: whole numbers that sum to `n`.
 */
const spans = (n: number, m: number) =>
  Array.from({ length: m }, (_, j) => {
    const from = Math.floor((j * n) / m)
    const weights: number[] = []
    for (let i = from; i * m < (j + 1) * n; i++)
      weights.push(Math.min((j + 1) * n, (i + 1) * m) - Math.max(j * n, i * m))
    return { from, weights }
  })

/**
 * `src`, `w` × `h` pixels of `k` samples each, shrunk to `nw` × `nh` by area average (box), as
 * `io.image`'s `maxSize` shrinks (ADR 0028, 5): each sample the mean of those under it weighted by
 * the area each covers, in integers, rows then columns, each pass rounding half up (not weighted by
 * alpha: a proxy's frames are opaque). The same bytes on every machine.
 */
export const shrink = <T extends Uint8Array | Uint16Array>(
  src: T,
  w: number,
  h: number,
  k: number,
  nw: number,
  nh: number,
): T => {
  const across = spans(w, nw)
  const rows = new Uint32Array(nw * h * k)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < nw; x++) {
      const { from, weights } = across[x] as { from: number; weights: number[] }
      for (let c = 0; c < k; c++) {
        let sum = 0
        for (let i = 0; i < weights.length; i++)
          sum += (weights[i] as number) * (src[(y * w + from + i) * k + c] as number)
        rows[(y * nw + x) * k + c] = Math.floor((2 * sum + w) / (2 * w))
      }
    }
  const out = new (src.constructor as new (n: number) => T)(nw * nh * k)
  const down = spans(h, nh)
  for (let y = 0; y < nh; y++) {
    const { from, weights } = down[y] as { from: number; weights: number[] }
    for (let x = 0; x < nw * k; x++) {
      let sum = 0
      for (let i = 0; i < weights.length; i++)
        sum += (weights[i] as number) * (rows[(from + i) * nw * k + x] as number)
      out[y * nw * k + x] = Math.floor((2 * sum + h) / (2 * h))
    }
  }
  return out
}

/**
 * A frame's bytes in `format` at `w` × `h` shrunk to `nw` × `nh` (#507): RGBA as one image of 4
 * samples, I420 plane by plane (Y to `nw` × `nh`, Cb and Cr to half that, rounded up).
 */
const shrinkFrame = (
  bytes: Uint8Array,
  format: 'rgba' | 'yuv420p' | 'yuv420p10',
  w: number,
  h: number,
  nw: number,
  nh: number,
): Uint8Array => {
  if (format === 'rgba') return shrink(bytes, w, h, 4, nw, nh)
  const samples =
    format === 'yuv420p10'
      ? new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2)
      : bytes
  const [cw, ch, ncw, nch] = [w, h, nw, nh].map((n) => Math.ceil(n / 2)) as [
    number,
    number,
    number,
    number,
  ]
  const planes = [
    shrink(samples.subarray(0, w * h), w, h, 1, nw, nh),
    shrink(samples.subarray(w * h, w * h + cw * ch), cw, ch, 1, ncw, nch),
    shrink(samples.subarray(w * h + cw * ch), cw, ch, 1, ncw, nch),
  ]
  const out = new (samples.constructor as new (n: number) => Uint8Array | Uint16Array)(
    nw * nh + 2 * ncw * nch,
  )
  out.set(planes[0] as never)
  out.set(planes[1] as never, nw * nh)
  out.set(planes[2] as never, nw * nh + ncw * nch)
  return new Uint8Array(out.buffer)
}

/** A viewer's own file's sample depth, from its first frame's format (I420P10 is 10 bits). */
const depthOf = async (sink: VideoSampleSink, first: number): Promise<Info['bits']> => {
  const sample = await sink.getSample(first)
  const format = sample?.format ?? ''
  sample?.close()
  return format.includes('P10') ? 10 : format.includes('P12') ? 12 : 8
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
      const space = await track.getColorSpace()
      const first = await track.getFirstTimestamp()
      const sink = new VideoSampleSink(track)
      return {
        info: {
          width: track.displayWidth,
          height: track.displayHeight,
          fps: stats.averagePacketRate,
          frames: stats.packetCount,
          bits: await depthOf(sink, first),
          // As the file tags it, BT.601 limited untagged (node/services.ts videoColour).
          colour: {
            matrix:
              space.matrix === 'bt709'
                ? 'bt709'
                : // WebCodecs names it; TypeScript's DOM types do not yet.
                  (space.matrix as string | null | undefined) === 'bt2020-ncl'
                  ? 'bt2020nc'
                  : 'bt601',
            range: space.fullRange ? 'full' : 'limited',
            chroma: 'left',
          },
        },
        first,
        sink,
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
      info: { ...info, colour: PROXY },
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

  const frame = async (
    clip: Clip,
    path: string,
    index: number,
    format: 'rgba' | 'yuv420p' | 'yuv420p10',
  ): Promise<Uint8Array> => {
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
        return format === 'rgba'
          ? await rgba(value, info)
          : await i420(value, info, `io.video(${path})`, format === 'yuv420p10')
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
    image: async (path, maxSize) =>
      decodeImage(
        await fetchBytes(new URL(path.replace(/^\.?\//, ''), files), `io.image(${path})`),
        path,
        maxSize,
      ),
    cacheGet: async (hash) => cache.get(hash) ?? null,
    cachePut: async (hash, bytes) => void cache.set(hash, bytes),
    videoOpen: async (path, _declared, maxSize) => {
      const { alpha: _, ...info } = (await clipOf(path)).info
      return { ...info, ...fitSize(info.width, info.height, maxSize) }
    },
    videoFrame: async (path, index, format, maxSize) => {
      const clip = await clipOf(path)
      const bytes = await frame(clip, path, index, format)
      const { width: w, height: h } = clip.info
      const size = fitSize(w, h, maxSize)
      return size.width === w && size.height === h
        ? bytes
        : shrinkFrame(bytes, format, w, h, size.width, size.height)
    },
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
