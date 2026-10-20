// An analyser with no model: regions from masks a person made (Photoshop, Figma, a paint program),
// one PNG per region at the image's size. White or opaque is inside: a PNG with alpha is read by
// its alpha, any other by its first channel. Writes regions/<image>/ as tools/regions-sam.py does.
// Run from the project root; the image must be inside the project.
//
//   node tools/regions-from-masks.ts assets/cat.jpg cat=masks/cat.png eye=masks/eye-l.png eye=masks/eye-r.png
//   node tools/regions-from-masks.ts assets/cat.jpg cat=masks/cat.png --out regions/cat

import { decode } from 'fast-png'
import { hex } from '../src/image/regions.ts'

export type Masked = { label: string; mask: Uint8Array; width: number; height: number }
export type Written = { json: string; files: { name: string; bytes: Uint8Array }[] }

/** A PNG's or a JPEG's size from its header, as stored (EXIF orientation is not applied, as io.image does not). */
export const imageSize = (bytes: Uint8Array, label = 'image') => {
  const at = (i: number) => bytes[i] as number
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: v.getUint32(16), height: v.getUint32(20) }
  }
  if (at(0) === 0xff && at(1) === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (at(i) !== 0xff) {
        i++
        continue
      }
      const marker = at(i + 1)
      // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the frame's size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { width: (at(i + 7) << 8) | at(i + 8), height: (at(i + 5) << 8) | at(i + 6) }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) i += 2
      else i += 2 + ((at(i + 2) << 8) | at(i + 3))
    }
  }
  throw new Error(`${label} is not a PNG or JPEG: convert it to PNG once`)
}

/** A mask PNG's coverage, 0–255: its alpha if it has one, else its first channel. */
export const coverage = (png: Uint8Array, label = 'mask') => {
  const p = decode(png)
  if (p.palette) throw new Error(`${label}: an indexed PNG; save it as greyscale or RGBA`)
  const shift = p.depth === 16 ? 8 : 0
  const channel = p.channels === 2 || p.channels === 4 ? p.channels - 1 : 0
  const out = new Uint8Array(p.width * p.height)
  for (let i = 0; i < out.length; i++)
    out[i] = (p.data[i * p.channels + channel] as number) >> shift
  return { mask: out, width: p.width, height: p.height }
}

/** A label as an id's stem: it names a file, so lowercase letters, digits and dashes only. */
export const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'region'

/**
 * The regions artifact for `image` (its project path and bytes) from whole-image masks: each
 * cropped to its box, with its centre, and the smallest other region holding 90% of it as parent.
 */
export const regionsFromMasks = async (
  image: { path: string; bytes: Uint8Array },
  masks: readonly Masked[],
  tool: Record<string, unknown> = { script: 'tools/regions-from-masks.ts' },
  params: Record<string, unknown> = {},
): Promise<Written> => {
  if (masks.length === 0) throw new Error('No masks: give at least one label=mask.png')
  const { width: W, height: H } = imageSize(image.bytes, image.path)
  const files: Written['files'] = []
  const count = new Map<string, number>()
  const regions = masks.map((m) => {
    if (m.width !== W || m.height !== H)
      throw new Error(
        `The ${m.label} mask is ${m.width}×${m.height}; it must be ${W}×${H}, the size of ${image.path}`,
      )
    let x0 = W
    let y0 = H
    let x1 = -1
    let y1 = -1
    let sum = 0
    let cx = 0
    let cy = 0
    let area = 0
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const a = m.mask[y * W + x] as number
        if (a === 0) continue
        sum += a
        cx += a * (x + 0.5)
        cy += a * (y + 0.5)
        if (a > 127) {
          area++
          x0 = Math.min(x0, x)
          y0 = Math.min(y0, y)
          x1 = Math.max(x1, x)
          y1 = Math.max(y1, y)
        }
      }
    if (area === 0) throw new Error(`The ${m.label} mask has no pixel over half coverage`)
    const stem = slug(m.label)
    const n = count.get(stem) ?? 0
    count.set(stem, n + 1)
    const id = `${stem}-${n}`
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    const crop = new Uint8Array(w * h)
    for (let y = 0; y < h; y++)
      crop.set(m.mask.subarray((y0 + y) * W + x0, (y0 + y) * W + x0 + w), y * w)
    files.push({ name: `${id}.u8`, bytes: crop })
    return {
      region: {
        id,
        label: m.label,
        score: 1,
        box: [x0, y0, w, h] as [number, number, number, number],
        centre: [Math.round((cx / sum) * 10) / 10, Math.round((cy / sum) * 10) / 10] as [
          number,
          number,
        ],
        mask: {
          file: `${id}.u8`,
          dtype: 'u8' as const,
          channels: 1 as const,
          width: w,
          height: h,
          rowStride: w,
          at: [x0, y0] as [number, number],
        },
      },
      mask: m.mask,
      area,
    }
  })
  /** The pixels both regions hold, counted only where their boxes meet. */
  const shared = (a: (typeof regions)[number], b: (typeof regions)[number]) => {
    const [ax, ay, aw, ah] = a.region.box
    const [bx, by, bw, bh] = b.region.box
    let both = 0
    for (let y = Math.max(ay, by); y < Math.min(ay + ah, by + bh); y++)
      for (let x = Math.max(ax, bx); x < Math.min(ax + aw, bx + bw); x++) {
        const i = y * W + x
        if ((a.mask[i] as number) > 127 && (b.mask[i] as number) > 127) both++
      }
    return both
  }
  const out = regions.map((r) => {
    let parent: (typeof regions)[number] | undefined
    for (const q of regions) {
      if (q === r || q.area <= r.area || (parent && q.area >= parent.area)) continue
      if (shared(r, q) >= 0.9 * r.area) parent = q
    }
    return parent ? { ...r.region, parent: parent.region.id } : r.region
  })
  const json = JSON.stringify(
    {
      format: 'shaderera.analysis/1',
      kind: 'regions',
      source: {
        path: image.path,
        bytes: image.bytes.length,
        sha256: await hex(image.bytes),
        width: W,
        height: H,
      },
      tool,
      params,
      regions: out,
    },
    null,
    2,
  )
  return { json, files }
}

if (import.meta.main) {
  const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } = await import(
    'node:fs'
  )
  const { basename, extname, isAbsolute, join, relative, resolve } = await import('node:path')
  const fail = (message: string) => {
    console.error(message)
    process.exit(2)
  }
  const args = process.argv.slice(2)
  const at = args.indexOf('--out')
  const outArg = at >= 0 ? args.splice(at, 2)[1] : undefined
  const [image, ...pairs] = args
  if (!image || pairs.length === 0)
    fail(
      'Usage: node tools/regions-from-masks.ts <image> <label>=<mask.png>... [--out regions/<name>]',
    )
  const path = relative(process.cwd(), resolve(image as string)).replaceAll('\\', '/')
  if (path === '' || path.startsWith('../') || path === '..' || isAbsolute(path))
    fail(`${image} is outside this project: run from the project root, with the image inside it`)
  const out = outArg ?? join('regions', basename(path, extname(path)))
  const old = join(out, 'regions.json')
  if (existsSync(old)) {
    const was = JSON.parse(readFileSync(old, 'utf8'))?.source?.path
    if (was !== path)
      fail(`${out} holds the regions of ${was}; give this image its own folder with --out`)
  }
  const masks = pairs.map((p) => {
    const eq = p.indexOf('=')
    if (eq < 1) fail(`"${p}" is not label=mask.png`)
    const file = p.slice(eq + 1)
    return { label: p.slice(0, eq), ...coverage(readFileSync(file), file) }
  })
  const written = await regionsFromMasks(
    { path, bytes: readFileSync(path) },
    masks,
    { script: 'tools/regions-from-masks.ts' },
    { masks: pairs },
  )
  mkdirSync(out, { recursive: true })
  for (const f of readdirSync(out)) if (f.endsWith('.u8')) rmSync(join(out, f))
  for (const f of written.files) writeFileSync(join(out, f.name), f.bytes)
  writeFileSync(join(out, 'regions.json'), `${written.json}\n`)
  console.log(
    `${out}/regions.json: ${written.files.map((f) => f.name.replace('.u8', '')).join(', ')}`,
  )
}
