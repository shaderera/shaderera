import { createCanvas, Path2D } from '@napi-rs/canvas'

const HALF = Math.PI
/** Skia also drops a sweep within about 1e-6 of a full turn: count those as full (0.01 px at r = 1000). */
const FULL = 2 * Math.PI - 1e-5

type Arc = (x: number, y: number, r: number, start: number, end: number, ccw?: boolean) => void
type Ellipse = (
  x: number,
  y: number,
  rx: number,
  ry: number,
  rotation: number,
  start: number,
  end: number,
  ccw?: boolean,
) => void
type Arcs = { arc: Arc; ellipse: Ellipse }

const patched = new WeakSet<object>()

/**
 * Makes `arc` and `ellipse` draw a full turn the way the browser does. @napi-rs/canvas drops an
 * arc whose sweep is 2π or more for many start angles, depending on how the angles round
 * (`arc(x, y, r, -π/2, 3π/2)` draws nothing; #405). Two half turns from the same start draw it.
 */
export const fullTurns = (proto: Arcs): void => {
  if (patched.has(proto)) return
  patched.add(proto)
  const { arc, ellipse } = proto
  proto.arc = function (this: Arcs, x, y, r, start, end, ccw = false) {
    if ((ccw ? start - end : end - start) < FULL) return arc.call(this, x, y, r, start, end, ccw)
    const half = ccw ? -HALF : HALF
    arc.call(this, x, y, r, start, start + half, ccw)
    arc.call(this, x, y, r, start + half, start + 2 * half, ccw)
  }
  proto.ellipse = function (this: Arcs, x, y, rx, ry, rotation, start, end, ccw = false) {
    if ((ccw ? start - end : end - start) < FULL)
      return ellipse.call(this, x, y, rx, ry, rotation, start, end, ccw)
    const half = ccw ? -HALF : HALF
    ellipse.call(this, x, y, rx, ry, rotation, start, start + half, ccw)
    ellipse.call(this, x, y, rx, ry, rotation, start + half, start + 2 * half, ccw)
  }
}

/** Patches the 2D context and Path2D of @napi-rs/canvas, once. */
export const fixFullTurns = (): void => {
  fullTurns(Object.getPrototypeOf(createCanvas(1, 1).getContext('2d')) as Arcs)
  fullTurns(Path2D.prototype as unknown as Arcs)
}
