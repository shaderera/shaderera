// `still --compare-file <image> --regions <file>`: the parts of a still reference scored apart.
// The file is a regions artifact (shaderera.analysis/1, kind `regions`) or boxes with names
// (shaderera.boxes/1), both as docs/analysis.md ("Regions (still image)") defines them; a field it
// does not know is ignored. Every region becomes a mask in the film's frame pixels.
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inside } from '../node/inside.ts'
import { scaleFrame } from '../review/reference.ts'
import type { Mask } from '../review/structure.ts'
import type { Region } from './crop.ts'

/** One region to score: its mask in the film's frame, and where it came from. */
export type ScoredRegion = {
  id: string
  /** The artifact's label ("eye"); none for a box. */
  label?: string
  /** The mask's bounding box in the film's frame pixels. */
  box: Region
  /** The mask's area in pixels: its coverage summed over 255. */
  area: number
  mask: Mask
}

export type RegionsFile = {
  file: string
  /** `regions`: a regions artifact; `boxes`: boxes with names (docs/analysis.md). */
  kind: 'regions' | 'boxes'
  /** The pixels the file is written in: the reference's or the film's frame. */
  in: [number, number]
  regions: ScoredRegion[]
}

const FORMAT = 'shaderera.analysis/1'
/** Boxes with names. A file of boxes may leave `format` out: it is this one. */
const BOXES = 'shaderera.boxes/1'

/** The reference as the regions are checked against it: its path, size and sha256. */
type Reference = { file: string; width: number; height: number; sha256: string }

type Obj = { [k: string]: unknown }
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const whole = (v: unknown, least: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= least

/**
 * Reads a regions file for a reference image and the film's frame. An artifact must be of the
 * reference's own bytes (its sha256); boxes must be in the reference's pixels or the film's. Either
 * is scaled to the film's frame with the reference's filter when it is in the reference's pixels
 * and the sizes differ. Throws, naming the file, on anything else. With `within` (a project's
 * root, for MCP), every file it reads must be in it, also through a symbolic link (inside).
 */
export const loadRegionsFile = (
  path: string,
  reference: Reference,
  film: { width: number; height: number },
  within?: string,
): RegionsFile => {
  const file = statSync(path, { throwIfNoEntry: false })?.isDirectory()
    ? join(path, 'regions.json')
    : path
  const read = (f: string) => readFileSync(within === undefined ? f : inside(within, f))
  let doc: unknown
  try {
    doc = JSON.parse(read(file).toString('utf8'))
  } catch (e) {
    throw new Error(`--regions ${file}: ${(e as Error).message}.`)
  }
  if (!isObj(doc)) throw new Error(`--regions ${file} is not a JSON object: ${shapes}`)
  if (
    typeof doc.format === 'string' &&
    doc.format.startsWith('shaderera.boxes/') &&
    doc.format !== BOXES
  )
    throw new Error(
      `--regions ${file} is ${JSON.stringify(doc.format)}: this shaderera reads ${BOXES}. Update shaderera.`,
    )
  const placed =
    doc.format === undefined || doc.format === BOXES
      ? boxes(file, doc, reference, film)
      : artifact(file, doc, reference, read)
  const [w, h] = placed.in
  const ids = new Set<string>()
  const regions = placed.masks.map(({ id, label, coverage }) => {
    if (ids.has(id)) throw new Error(`--regions ${file} names "${id}" twice: give each its own.`)
    ids.add(id)
    const scaled =
      w === film.width && h === film.height ? coverage : scaleMask(coverage, w, h, film)
    const mask = trimmed(scaled, film.width, film.height)
    if (!mask)
      throw new Error(
        `--regions ${file}: "${id}" covers no pixel of the ${film.width}×${film.height} frame.`,
      )
    let sum = 0
    for (const c of mask.coverage) sum += c
    return {
      id,
      ...(label === undefined ? {} : { label }),
      box: { x: mask.x, y: mask.y, width: mask.width, height: mask.height },
      area: Math.round((sum / 255) * 100) / 100,
      mask,
    }
  })
  return { file, kind: placed.kind, in: placed.in, regions }
}

/** What --regions takes, for the messages. */
const shapes = `give a regions artifact (its folder or regions.json, shaderera.analysis/1 of kind regions, as docs/analysis.md defines it) or boxes: { "format": "${BOXES}", "width": w, "height": h, "boxes": [{ "name": "title", "x": 0, "y": 0, "width": 10, "height": 10 }] }.`

type Placed = {
  kind: RegionsFile['kind']
  in: [number, number]
  masks: { id: string; label?: string; coverage: Uint8Array }[]
}

/** A regions artifact (docs/analysis.md): each region's u8 mask placed in the reference's pixels. */
const artifact = (
  file: string,
  doc: Obj,
  reference: Reference,
  read: (f: string) => Buffer,
): Placed => {
  if (doc.format !== FORMAT)
    throw new Error(
      `--regions ${file} is ${JSON.stringify(doc.format)}: this shaderera reads ${FORMAT} of kind regions and ${BOXES}. Update shaderera, or write it again in one of those.`,
    )
  if (doc.kind !== 'regions')
    throw new Error(
      `--regions ${file} is a ${FORMAT} artifact of kind ${JSON.stringify(doc.kind)}, not regions: ${shapes}`,
    )
  const source = isObj(doc.source) ? doc.source : {}
  if (source.sha256 !== reference.sha256)
    throw new Error(
      `--regions ${file} was measured from other bytes than ${reference.file} (${String(source.path)}): its regions are of another image. Measure this one, or give boxes.`,
    )
  const [W, H] = [reference.width, reference.height]
  if (source.width !== W || source.height !== H)
    throw new Error(
      `--regions ${file} says its image is ${String(source.width)}×${String(source.height)}, and ${reference.file} is ${W}×${H}: its regions are of another image. Measure this one, or give boxes.`,
    )
  if (!Array.isArray(doc.regions) || doc.regions.length === 0)
    throw new Error(`--regions ${file} has no regions.`)
  const dir = dirname(file)
  const masks = doc.regions.map((q: unknown, n: number) => {
    const r = isObj(q) ? q : {}
    const id = typeof r.id === 'string' && r.id !== '' ? r.id : undefined
    const m = isObj(r.mask) ? r.mask : {}
    const at = Array.isArray(m.at) ? m.at : []
    const name = typeof m.file === 'string' ? m.file : ''
    if (
      !id ||
      m.dtype !== 'u8' ||
      m.channels !== 1 ||
      !whole(m.width, 1) ||
      !whole(m.height, 1) ||
      !whole(m.rowStride, m.width as number) ||
      !whole(at[0], 0) ||
      !whole(at[1], 0)
    )
      throw new Error(
        `--regions ${file}: region ${id ?? n} is not as docs/analysis.md defines one (an id, and a u8 mask of 1 channel with file, width, height, rowStride and at): write it again.`,
      )
    // A mask is a file beside regions.json: a name, never a path out of the folder.
    if (!/^[^/\\]+$/.test(name) || name === '.' || name === '..')
      throw new Error(`--regions ${file}: region ${id}'s mask file "${name}" is not a file name.`)
    let bytes: Buffer
    try {
      bytes = read(join(dir, name))
    } catch (e) {
      throw new Error(
        `--regions ${file}: region ${id}'s mask ${name} could not be read (${(e as Error).message}): write it again.`,
      )
    }
    const { width, height, rowStride } = m as { width: number; height: number; rowStride: number }
    if (bytes.length !== rowStride * height)
      throw new Error(
        `--regions ${file}: ${name} has ${bytes.length} bytes, not ${rowStride} × ${height}: write it again.`,
      )
    const coverage = new Uint8Array(W * H)
    const [x0, y0] = at as [number, number]
    for (let y = 0; y < height && y0 + y < H; y++)
      for (let x = 0; x < width && x0 + x < W; x++)
        coverage[(y0 + y) * W + x0 + x] = bytes[y * rowStride + x] as number
    return {
      id,
      ...(typeof r.label === 'string' ? { label: r.label } : {}),
      coverage,
    }
  })
  return { kind: 'regions', in: [W, H], masks }
}

/** Boxes with names, in the reference's pixels or the film's: each one a mask of full coverage. */
const boxes = (
  file: string,
  doc: Obj,
  reference: Reference,
  film: { width: number; height: number },
): Placed => {
  if (!whole(doc.width, 1) || !whole(doc.height, 1) || !Array.isArray(doc.boxes))
    throw new Error(`--regions ${file} is neither: ${shapes}`)
  const [W, H] = [doc.width, doc.height]
  const ofReference = W === reference.width && H === reference.height
  const ofFilm = W === film.width && H === film.height
  if (!ofReference && !ofFilm)
    throw new Error(
      `--regions ${file} is in ${W}×${H} pixels: boxes are in the reference's pixels (${reference.width}×${reference.height}) or the film's (${film.width}×${film.height}).`,
    )
  if (doc.boxes.length === 0) throw new Error(`--regions ${file} has no boxes.`)
  const masks = doc.boxes.map((q: unknown, n: number) => {
    const b = isObj(q) ? q : {}
    const id = typeof b.name === 'string' && b.name !== '' ? b.name : undefined
    if (
      !id ||
      !whole(b.x, -Infinity) ||
      !whole(b.y, -Infinity) ||
      !whole(b.width, 1) ||
      !whole(b.height, 1)
    )
      throw new Error(
        `--regions ${file}: box ${id ?? n} needs a name and x, y, width and height in whole pixels, the size 1 or more.`,
      )
    const { x, y, width, height } = b as Region
    const coverage = new Uint8Array(W * H)
    for (let row = Math.max(0, y); row < Math.min(H, y + height); row++)
      coverage.fill(255, row * W + Math.max(0, x), row * W + Math.min(W, x + width))
    return { id, coverage }
  })
  // Boxes in the film's pixels are placed as they are, even when the reference is another size.
  return { kind: 'boxes', in: [W, H], masks }
}

/** A coverage plane of `w`×`h` scaled to the film's frame as scaleFrame scales the reference. */
const scaleMask = (
  coverage: Uint8Array,
  w: number,
  h: number,
  film: { width: number; height: number },
): Uint8Array => {
  const rgba = new Uint8Array(w * h * 4)
  for (let i = 0; i < coverage.length; i++) {
    const c = coverage[i] as number
    rgba[i * 4] = c
    rgba[i * 4 + 3] = 255
  }
  const scaled = scaleFrame(rgba, w, h, film.width, film.height)
  const out = new Uint8Array(film.width * film.height)
  for (let i = 0; i < out.length; i++) out[i] = scaled[i * 4] as number
  return out
}

/** A whole-frame coverage plane cut to the box of what it covers; undefined when nothing. */
const trimmed = (coverage: Uint8Array, W: number, H: number): Mask | undefined => {
  let x0 = W
  let y0 = H
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if ((coverage[y * W + x] as number) > 0) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  if (x1 < 0) return undefined
  const width = x1 - x0 + 1
  const height = y1 - y0 + 1
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++)
    out.set(coverage.subarray((y0 + y) * W + x0, (y0 + y) * W + x0 + width), y * width)
  return { x: x0, y: y0, width, height, coverage: out }
}
