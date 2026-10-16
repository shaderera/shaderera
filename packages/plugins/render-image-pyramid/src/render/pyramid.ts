// A large picture drawn at any size with the same pixels whatever was drawn before. Canvas2D's
// 'medium' and 'high' smoothing read mipmaps that Skia keeps in a cache large pictures evict, so a
// crop drawn small depends on the frames before it. A pyramid built once holds the picture's halves,
// each drawn from the one above at exactly half size (bilinear at half size averages 2×2), and
// `blit` draws from the level that is at most twice the size on screen, with plain bilinear.

type Io = { canvas(width: number, height: number): OffscreenCanvas }
type Ctx = OffscreenCanvasRenderingContext2D

/** The picture's halves: `levels[0]` is the picture itself, each next one half the size. */
export type Pyramid = { levels: OffscreenCanvas[]; width: number; height: number }

export type PyramidOptions = {
  /** Halving stops once the longer side is at most this, px (1200). */
  min?: number
}

/** Builds the pyramid of a picture, once (in open). The picture is kept as level 0, not copied. */
export const pyramid = (io: Io, picture: OffscreenCanvas, o: PyramidOptions = {}): Pyramid => {
  const min = o.min ?? 1200
  if (!(min >= 1)) throw new Error(`pyramid: min must be at least 1 px, got ${min}`)
  const levels = [picture]
  let top = picture
  while (Math.max(top.width, top.height) > min) {
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
  return { levels, width: picture.width, height: picture.height }
}

/**
 * Draws the picture's rectangle (sx, sy, sw, sh), in level 0's pixels, into (dx, dy, dw, dh) as
 * `drawImage` does, from the level that is at most twice the size drawn. It sets the context's
 * smoothing to 'low' and leaves it so; transforms, alpha and composite apply as usual.
 */
export const blit = (
  ctx: Ctx,
  pic: Pyramid,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
) => {
  const ratio = Math.max(Math.abs(sw / dw), Math.abs(sh / dh))
  const i = Math.max(0, Math.min(pic.levels.length - 1, Math.floor(Math.log2(Math.max(1, ratio)))))
  const level = pic.levels[i] as OffscreenCanvas
  const kx = level.width / pic.width
  const ky = level.height / pic.height
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'low'
  ctx.drawImage(level, sx * kx, sy * ky, sw * kx, sh * ky, dx, dy, dw, dh)
}
