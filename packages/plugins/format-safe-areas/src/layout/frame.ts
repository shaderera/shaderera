// Where text may go (and which corner is free for a credit), and how a lens keeps a shot when the
// frame turns tall. A variant is relaid for its format, never cropped from another.

export type Platform = 'none' | 'shorts' | 'reels' | 'tiktok'

/** Margins in pixels, and the box inside them. */
export type Area = {
  left: number
  right: number
  top: number
  bottom: number
  x: number
  y: number
  width: number
  height: number
}

/**
 * The safe area of a W×H frame. With no platform, generic title-safe margins (not a platform
 * spec): vertical (taller than 3:4) top 14 %, bottom 20 %, sides 5 %; near-square 6 %; landscape
 * 5 %. For a platform, a vertical frame also keeps clear of its own UI. `reels` is Meta's Reels ads
 * safe zone (14 % top, 35 % bottom, 6 % sides; its ads guide, read 2026-10-12). `shorts` and
 * `tiktok` are estimates of the right-hand rail and the caption line, not checked against a spec:
 * check the platform's current safe-zone files before a delivery.
 */
export const safeArea = (width: number, height: number, platform: Platform = 'none'): Area => {
  const r = height / width
  let m: { left: number; right: number; top: number; bottom: number }
  if (r > 4 / 3)
    m =
      platform === 'none'
        ? { left: 0.05, right: 0.05, top: 0.14, bottom: 0.2 }
        : platform === 'reels'
          ? { left: 0.06, right: 0.06, top: 0.14, bottom: 0.35 }
          : { left: 0.07, right: 0.16, top: 0.14, bottom: 0.25 }
  else if (r >= 0.8) m = { left: 0.06, right: 0.06, top: 0.06, bottom: 0.06 }
  else m = { left: 0.05, right: 0.05, top: 0.05, bottom: 0.05 }
  const left = m.left * width
  const right = m.right * width
  const top = m.top * height
  const bottom = m.bottom * height
  return {
    left,
    right,
    top,
    bottom,
    x: left,
    y: top,
    width: width - left - right,
    height: height - top - bottom,
  }
}

export type Corner = 'tl' | 'tr' | 'bl' | 'br'

/** Where text sits in a corner: the point it anchors to and the canvas alignment there. */
export type Anchor = {
  corner: Corner
  x: number
  y: number
  align: 'left' | 'right'
  baseline: 'top' | 'bottom'
}

/**
 * The corner of a W×H frame farthest from the subject, where an editor puts a credit: where there
 * is room. The subject is a point [x, y] or a box [x, y, width, height] (its centre counts), in px
 * on screen. The anchor is that corner of the safe area, aligned so text grows inward. A tie goes
 * to the first of bl, br, tr, tl.
 */
export const freeCorner = (
  subject: [number, number] | [number, number, number, number],
  width: number,
  height: number,
  platform: Platform = 'none',
): Anchor => {
  const [x, y] =
    subject.length === 4 ? [subject[0] + subject[2] / 2, subject[1] + subject[3] / 2] : subject
  const corners: [Corner, number, number][] = [
    ['bl', 0, height],
    ['br', width, height],
    ['tr', width, 0],
    ['tl', 0, 0],
  ]
  const [corner] = corners.reduce((far, c) =>
    Math.hypot(c[1] - x, c[2] - y) > Math.hypot(far[1] - x, far[2] - y) ? c : far,
  )
  const a = safeArea(width, height, platform)
  const right = corner === 'tr' || corner === 'br'
  const top = corner === 'tl' || corner === 'tr'
  return {
    corner,
    x: right ? a.x + a.width : a.x,
    y: top ? a.y : a.y + a.height,
    align: right ? 'right' : 'left',
    baseline: top ? 'top' : 'bottom',
  }
}

/**
 * A vertical field of view (radians) designed for a `designed` aspect (16:9), opened for a
 * narrower frame. `opening` 0 keeps the height (and loses the sides), 1 keeps the width (the
 * subject gets small); 0.5, half way on a log scale, keeps a wide shot reading in 9:16. Open it
 * further (0.75) for a shot whose subject spans the width, such as a word. A frame as wide as
 * the design or wider keeps the lens.
 */
export const widenFov = (fov: number, aspect: number, opening = 0.5, designed = 16 / 9) =>
  aspect >= designed ? fov : 2 * Math.atan(Math.tan(fov / 2) * (designed / aspect) ** opening)
