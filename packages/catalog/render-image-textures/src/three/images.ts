// Images as three.js textures, decoded the same in the browser and in Node: PNG and JPEG with
// pure-JS decoders (no canvas, no browser decoder whose colour handling may differ), so every host
// samples the same pixels. Other formats (WebP, AVIF, GIF, a video's frames) are converted to PNG
// once with tools/to-png.ts, and the PNGs are what the film reads.

import type { Host } from '@shaderera/core'
import { convertIndexedToRgb, decode as decodePng } from 'fast-png'
import jpeg from 'jpeg-js'
import * as THREE from 'three/webgpu'

export type Decoded = { width: number; height: number; data: Uint8Array; hasAlpha: boolean }

/** RGBA bytes, rows top-down, from PNG or JPEG bytes. */
export const decodeImage = (bytes: Uint8Array, label = 'image'): Decoded => {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const png = decodePng(bytes)
    const { width, height } = png
    const out = new Uint8Array(width * height * 4)
    let src = png.data as Uint8Array | Uint16Array
    let channels = png.channels
    if (png.palette) {
      src = convertIndexedToRgb(png)
      channels = png.palette[0]?.length ?? 3
    }
    const shift = png.depth === 16 ? 8 : 0
    for (let i = 0; i < width * height; i++) {
      const at = (c: number) => (src[i * channels + c] as number) >> shift
      const o = i * 4
      if (channels <= 2) {
        out[o] = out[o + 1] = out[o + 2] = at(0)
        out[o + 3] = channels === 2 ? at(1) : 255
      } else {
        out[o] = at(0)
        out[o + 1] = at(1)
        out[o + 2] = at(2)
        out[o + 3] = channels === 4 ? at(3) : 255
      }
    }
    return { width, height, data: out, hasAlpha: channels === 4 || channels === 2 }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const img = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxMemoryUsageInMB: 1024,
    })
    return { width: img.width, height: img.height, data: img.data as Uint8Array, hasAlpha: false }
  }
  throw new Error(`${label} is not a PNG or JPEG; convert it with: node tools/to-png.ts ${label}`)
}

/**
 * A texture for an image's pixels: sRGB, mipmapped, flipped so v = 0 is the image's bottom. Its
 * colours are the artwork's: no grading is applied here.
 */
export const textureOf = (img: Decoded) => {
  const { width: w, height: h } = img
  const data = new Uint8Array(w * h * 4)
  const row = w * 4
  for (let y = 0; y < h; y++) data.set(img.data.subarray((h - 1 - y) * row, (h - y) * row), y * row)
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.anisotropy = 8
  tex.needsUpdate = true
  return tex
}

/** Reads, decodes and uploads one image: its texture and its aspect (width over height). */
export const loadTexture = async (host: Host, path: string) => {
  const img = decodeImage(await host.io.read(path), path)
  return {
    texture: textureOf(img),
    aspect: img.width / img.height,
    width: img.width,
    height: img.height,
  }
}

/**
 * Several images packed into one atlas texture (rows of cells, each image fitted inside its cell
 * at its own proportions), for many cards drawn as one instanced mesh. Each rect is [u, v, w, h]
 * in the atlas, v up.
 */
export const loadAtlas = async (
  host: Host,
  paths: string[],
  o: { cell?: number; columns?: number } = {},
) => {
  const cell = o.cell ?? 512
  const columns = o.columns ?? Math.ceil(Math.sqrt(paths.length))
  const rows = Math.ceil(paths.length / columns)
  const W = columns * cell
  const H = rows * cell
  const data = new Uint8Array(W * H * 4)
  const rects: { rect: [number, number, number, number]; aspect: number }[] = []
  for (const [i, path] of paths.entries()) {
    const img = decodeImage(await host.io.read(path), path)
    const s = Math.min(cell / img.width, cell / img.height)
    const w = Math.max(1, Math.round(img.width * s))
    const h = Math.max(1, Math.round(img.height * s))
    const x0 = (i % columns) * cell + Math.floor((cell - w) / 2)
    const y0 = Math.floor(i / columns) * cell + Math.floor((cell - h) / 2)
    // Box-filtered down to the cell (every source pixel counted once), rows top-down.
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const sx0 = Math.floor((x * img.width) / w)
        const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * img.width) / w))
        const sy0 = Math.floor((y * img.height) / h)
        const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * img.height) / h))
        const acc = [0, 0, 0, 0]
        for (let sy = sy0; sy < sy1; sy++)
          for (let sx = sx0; sx < sx1; sx++)
            for (let c = 0; c < 4; c++)
              acc[c] = (acc[c] as number) + (img.data[(sy * img.width + sx) * 4 + c] as number)
        const n = (sx1 - sx0) * (sy1 - sy0)
        const o = ((y0 + y) * W + x0 + x) * 4
        for (let c = 0; c < 4; c++) data[o + c] = Math.round((acc[c] as number) / n)
      }
    rects.push({ rect: [x0 / W, 1 - (y0 + h) / H, w / W, h / H], aspect: img.width / img.height })
  }
  return { texture: textureOf({ width: W, height: H, data, hasAlpha: true }), rects }
}
