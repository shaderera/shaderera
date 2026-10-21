// A still placed into a rectangle of a Canvas2D frame: the decoded image onto a canvas, the cover
// and contain rectangles for a picture in a box, and halved copies that draw a large still small
// with the same pixels whatever was drawn before. Plain numbers in pixels (origin top-left, rows
// downward); where the box is and how it moves are the film's.

import type { DecodedImage } from '@shaderera/core'

/** The still's size in pixels: image-regions' `source` and a `Pyramid` are one. */
export type Picture = { width: number; height: number }

/** A rectangle, in pixels. */
export type Rect = { x: number; y: number; width: number; height: number }

/** A point of the picture, in its pixels: image-regions' `centre` is one. */
export type Point = readonly [number, number]

/** What `drawImage` takes: the part of the picture, and where it lands in the frame. */
export type Fit = { source: Rect; target: Rect }

type Ctx = OffscreenCanvasRenderingContext2D
type Io = { canvas(width: number, height: number): OffscreenCanvas }

/** A decoded image (`io.image`) on a canvas of its size; 16-bit rows are rounded to 8 bits. */
export const toCanvas = (io: Io, image: DecodedImage): OffscreenCanvas => {
  const canvas = io.canvas(image.width, image.height)
  const c = canvas.getContext('2d') as Ctx
  const data = c.createImageData(image.width, image.height)
  if (image.bits === 8) data.data.set(image.data)
  else
    for (let i = 0; i < image.data.length; i++)
      data.data[i] = Math.round((image.data[i] ?? 0) / 257)
  c.putImageData(data, 0, 0)
  return canvas
}

/**
 * The crop of the picture with `aspect` (width / height), `width` wide (the largest that fits by
 * default), centred on `focus` (the picture's centre by default): shrunk to fit, then slid back in,
 * so near an edge the focus sits off centre.
 */
export const crop = (picture: Picture, aspect: number, focus?: Point, width = Infinity): Rect => {
  const w = Math.min(width, picture.width, picture.height * aspect)
  const h = w / aspect
  const [cx, cy] = focus ?? [picture.width / 2, picture.height / 2]
  return {
    x: Math.min(picture.width - w, Math.max(0, cx - w / 2)),
    y: Math.min(picture.height - h, Math.max(0, cy - h / 2)),
    width: w,
    height: h,
  }
}

/** The picture filling the box: the largest crop of the box's aspect, centred on `focus`. */
export const cover = (picture: Picture, box: Rect, focus?: Point): Fit => ({
  source: crop(picture, box.width / box.height, focus),
  target: { ...box },
})

/**
 * The whole picture inside the box, as large as it fits: `align` places it in the space left over
 * (0 left or top, 1 right or bottom; centred by default).
 */
export const contain = (picture: Picture, box: Rect, align: Point = [0.5, 0.5]): Fit => {
  const k = Math.min(box.width / picture.width, box.height / picture.height)
  const w = picture.width * k
  const h = picture.height * k
  return {
    source: { x: 0, y: 0, width: picture.width, height: picture.height },
    target: {
      x: box.x + (box.width - w) * align[0],
      y: box.y + (box.height - h) * align[1],
      width: w,
      height: h,
    },
  }
}

/** A picture and its halved copies, `levels[0]` the picture itself. */
export type Pyramid = { width: number; height: number; levels: OffscreenCanvas[] }

/**
 * Halved copies of a picture, each drawn from the one above at half size with bilinear smoothing
 * (which at half size averages 2×2), until the long side is at most `smallest` px.
 */
export const pyramid = (io: Io, picture: OffscreenCanvas, smallest = 64): Pyramid => {
  const levels = [picture]
  let top = picture
  while (Math.max(top.width, top.height) > smallest) {
    const next = io.canvas(
      Math.max(1, Math.round(top.width / 2)),
      Math.max(1, Math.round(top.height / 2)),
    )
    const c = next.getContext('2d') as Ctx
    c.imageSmoothingEnabled = true
    c.imageSmoothingQuality = 'low'
    c.drawImage(top, 0, 0, next.width, next.height)
    levels.push(next)
    top = next
  }
  return { width: picture.width, height: picture.height, levels }
}

/**
 * Draws `source` (in the picture's pixels) into `target`, from the level that is no more than
 * twice the size drawn, with bilinear smoothing. The source is kept inside the level, and the
 * target cut to match: pixels sampled past a picture's edge depend on what was drawn before.
 */
export const drawFrom = (ctx: Ctx, p: Pyramid, source: Rect, target: Rect) => {
  const ratio = Math.min(source.width / target.width, source.height / target.height)
  const i = Math.max(0, Math.min(p.levels.length - 1, Math.floor(Math.log2(Math.max(1, ratio)))))
  const level = p.levels[i] as OffscreenCanvas
  const kx = level.width / p.width
  const ky = level.height / p.height
  const x0 = Math.max(0, source.x * kx)
  const y0 = Math.max(0, source.y * ky)
  const x1 = Math.min(level.width, (source.x + source.width) * kx)
  const y1 = Math.min(level.height, (source.y + source.height) * ky)
  if (x1 <= x0 || y1 <= y0) return
  const fx = target.width / (source.width * kx)
  const fy = target.height / (source.height * ky)
  const { imageSmoothingEnabled, imageSmoothingQuality } = ctx
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'low'
  ctx.drawImage(
    level,
    x0,
    y0,
    x1 - x0,
    y1 - y0,
    target.x + (x0 - source.x * kx) * fx,
    target.y + (y0 - source.y * ky) * fy,
    (x1 - x0) * fx,
    (y1 - y0) * fy,
  )
  ctx.imageSmoothingEnabled = imageSmoothingEnabled
  ctx.imageSmoothingQuality = imageSmoothingQuality
}
