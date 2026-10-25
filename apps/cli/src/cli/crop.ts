import type { Json } from '@shaderera/core'

/** A rectangle of the frame in pixels: left, top, width, height. */
export type Region = { x: number; y: number; width: number; height: number }

/** `x,y,w,h` in frame pixels. */
export const parseRegion = (text: string): Region => {
  const n = text.split(',').map((s) => Number(s.trim()))
  if (
    n.length !== 4 ||
    n.some((v) => !Number.isFinite(v)) ||
    (n[2] as number) <= 0 ||
    (n[3] as number) <= 0
  )
    throw new Error(
      `A region is x,y,width,height in frame pixels, such as 800,400,320,180: ${text}`,
    )
  const [x, y, width, height] = n as [number, number, number, number]
  return { x, y, width, height }
}

/**
 * The box of the object with this `id` in inspect's JSON: its `bbox`, else its `box` (a text
 * run's), as `[x, y, width, height]` or `{ x, y, width, height }` in frame pixels. Throws when
 * there is no such object or it has neither.
 */
export const objectRegion = (json: Json, id: string): Region => {
  let found: Json | undefined
  const walk = (v: Json) => {
    if (found !== undefined || v === null || typeof v !== 'object') return
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
      return
    }
    const o = v as { [k: string]: Json }
    if (o.id === id) {
      found = o
      return
    }
    for (const x of Object.values(o)) walk(x)
  }
  walk(json)
  if (found === undefined) throw new Error(`No object with id "${id}" in inspect.`)
  const { bbox, box: run } = found as { bbox?: Json; box?: Json }
  const b = bbox ?? run
  const box = Array.isArray(b)
    ? b
    : b && typeof b === 'object'
      ? [(b as Region).x, (b as Region).y, (b as Region).width, (b as Region).height]
      : undefined
  if (!box || box.length !== 4 || box.some((v) => typeof v !== 'number'))
    throw new Error(
      `The object "${id}" has no bbox or box in inspect: report one as bbox: [x, y, width, height] in frame pixels (a text run's box counts).`,
    )
  return parseRegion(box.join(','))
}

/**
 * The region of straight RGBA pixels, clamped to the frame, enlarged `scale` times by repeating
 * pixels (nearest neighbour), so every source pixel shows as a square block, never blurred.
 */
export const crop = (
  px: Uint8Array,
  frame: { width: number; height: number },
  region: Region,
  scale = 1,
): { pixels: Uint8Array; width: number; height: number; region: Region } => {
  if (!Number.isInteger(scale) || scale < 1 || scale > 16)
    throw new Error(`A scale is a whole number from 1 to 16, not ${scale}.`)
  const x0 = Math.max(0, Math.floor(region.x))
  const y0 = Math.max(0, Math.floor(region.y))
  const x1 = Math.min(frame.width, Math.ceil(region.x + region.width))
  const y1 = Math.min(frame.height, Math.ceil(region.y + region.height))
  if (x1 <= x0 || y1 <= y0)
    throw new Error(
      `The region ${JSON.stringify(region)} is outside the ${frame.width}×${frame.height} frame.`,
    )
  const w = (x1 - x0) * scale
  const h = (y1 - y0) * scale
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const from = ((y0 + Math.floor(y / scale)) * frame.width + x0 + Math.floor(x / scale)) * 4
      out.set(px.subarray(from, from + 4), (y * w + x) * 4)
    }
  return {
    pixels: out,
    width: w,
    height: h,
    region: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
  }
}
