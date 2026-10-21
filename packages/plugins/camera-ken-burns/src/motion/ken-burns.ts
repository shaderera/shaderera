// The crop of a still that a frame shows: framed on a box with headroom, and moved between two
// framings at an even speed. Plain numbers in the picture's pixels (origin top-left, rows
// downward); drawing the crop, finding the box and easing time are the film's.

import { crop, type Picture, type Rect } from '../image/fit.ts'

/** [x, y, width, height], as image-regions gives a region's box. */
export type Box = readonly [number, number, number, number]

/** A rectangle of the picture, in its pixels. */
export type View = Rect

export type Framing = {
  /** The box to frame, or 'full' for the largest crop of the frame's aspect. */
  on: Box | 'full'
  /** On a box, its share of the frame's height (0.5); on 'full', a zoom (1 shows it all). */
  fill?: number
  /** Where the box's centre sits, as a share of the frame's height from its top (0.42). */
  eye?: number
  /** The box's largest share of the frame's width (0.92): a wide box widens the view. */
  maxWidth?: number
  /** Offsets of the view's centre, as shares of its width and height. */
  dx?: number
  dy?: number
}

/** The part of the picture a framing shows in a frame of `aspect` (width / height). */
export const viewOf = (picture: Picture, f: Framing, aspect: number): View => {
  if (f.on === 'full') {
    const w = crop(picture, aspect).width / (f.fill ?? 1)
    return crop(
      picture,
      aspect,
      [picture.width / 2 + (f.dx ?? 0) * w, picture.height / 2 + (f.dy ?? 0) * (w / aspect)],
      w,
    )
  }
  const [bx, by, bw, bh] = f.on
  const w = Math.max((bh / (f.fill ?? 0.5)) * aspect, bw / (f.maxWidth ?? 0.92))
  const h = w / aspect
  const cx = bx + bw / 2 + (f.dx ?? 0) * w
  const cy = by + bh / 2 + (0.5 - (f.eye ?? 0.42) + (f.dy ?? 0)) * h
  return crop(picture, aspect, [cx, cy], w)
}

/**
 * The view at progress `p` of the move between two framings, 0 at `from` and 1 at `to`. The width
 * goes in log space, so a push in or out reads at an even speed; the centre goes in a straight
 * line. `p` is used as given: ease it before (motion-eases' `progress`).
 */
export const moveOf = (
  picture: Picture,
  from: Framing,
  to: Framing,
  p: number,
  aspect: number,
): View => {
  const a = viewOf(picture, from, aspect)
  const b = viewOf(picture, to, aspect)
  const w = a.width * (b.width / a.width) ** p
  const cx = a.x + a.width / 2 + (b.x + b.width / 2 - a.x - a.width / 2) * p
  const cy = a.y + a.height / 2 + (b.y + b.height / 2 - a.y - a.height / 2) * p
  return crop(picture, aspect, [cx, cy], w)
}
