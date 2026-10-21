// Images as three.js textures and atlases, from core's `io.image`: PNG and JPEG decoded in
// JavaScript by the host, the same pixels in every host. Other formats (WebP, AVIF, GIF, a video's
// frames) are converted to PNG once (the image-to-png plugin), and the PNGs are what the film reads.

import type { DecodedImage, Host } from '@shaderera/core'
import * as THREE from 'three/webgpu'

/** 8-bit RGBA, rows top-down: a 16-bit image keeps its high byte. */
const bytesOf = (img: DecodedImage) =>
  img.bits === 16 ? Uint8Array.from(img.data, (v) => v >> 8) : (img.data as Uint8Array)

/** The image at `path`, through the host's `io.image`. */
const imageOf = (host: Host, path: string) => {
  if (!host.io.image) throw new Error(`This host has no io.image to decode ${path}`)
  return host.io.image(path)
}

/**
 * A texture for an image's pixels: sRGB, mipmapped, flipped so v = 0 is the image's bottom. Its
 * colours are the artwork's: no grading is applied here.
 */
export const textureOf = (img: DecodedImage) => {
  const { width: w, height: h } = img
  const src = bytesOf(img)
  const data = new Uint8Array(w * h * 4)
  const row = w * 4
  for (let y = 0; y < h; y++) data.set(src.subarray((h - 1 - y) * row, (h - y) * row), y * row)
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.anisotropy = 8
  tex.needsUpdate = true
  return tex
}

/** Reads one image through `io.image` and uploads it: its texture and its aspect (width over height). */
export const loadTexture = async (host: Host, path: string) => {
  const img = await imageOf(host, path)
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
    const img = await imageOf(host, path)
    const px = bytesOf(img)
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
              acc[c] = (acc[c] as number) + (px[(sy * img.width + sx) * 4 + c] as number)
        const n = (sx1 - sx0) * (sy1 - sy0)
        const o = ((y0 + y) * W + x0 + x) * 4
        for (let c = 0; c < 4; c++) data[o + c] = Math.round((acc[c] as number) / n)
      }
    rects.push({ rect: [x0 / W, 1 - (y0 + h) / H, w / W, h / H], aspect: img.width / img.height })
  }
  return { texture: textureOf({ width: W, height: H, bits: 8, data }), rects }
}
