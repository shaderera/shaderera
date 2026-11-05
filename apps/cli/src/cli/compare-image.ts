// `still --compare-file <image>`: the film's still at each time asked for, measured against a
// reference image (a poster, a screenshot, a hero): PSNR and ΔE as `--compare` gives them, SSIM
// and an edge score, for the whole frame and for each region of `--regions`. It measures and never
// judges (decisions 0011 and 0032): there is no pass or fail.
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { compareFrames, deltaEs } from '../review/compare.ts'
import {
  fitBox,
  inFrame,
  placeFrame,
  row,
  type Scaling,
  scaleFrame,
  scaling,
} from '../review/reference.ts'
import {
  EDGES,
  type Edges,
  edges,
  everywhere,
  heatMap,
  luma,
  maskedMax,
  maskedMean,
  SSIM,
  sobel,
  ssim,
} from '../review/structure.ts'
import { decodeImage } from '../runner/image.ts'
import { insideFilm } from './args.ts'
import type { CompareFileOptions } from './compare-file.ts'
import { crop, type Region } from './crop.ts'
import { loadRegionsFile, type RegionsFile, type ScoredRegion } from './regions-file.ts'

/** Whether a file starts as a PNG or a JPEG does: a still reference, not a clip. */
export const isImage = (path: string): boolean => {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return false
  }
  try {
    const head = new Uint8Array(4)
    const n = readSync(fd, head, 0, 4, 0)
    if (n < 3) return false
    const png = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
    const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
    return png || jpeg
  } finally {
    closeSync(fd)
  }
}

/** One region's scores at one time: SSIM, the edge score and ΔE over its mask. */
export type RegionScore = {
  id: string
  /** The SSIM map's mean weighted by the mask's coverage. */
  ssim: number
  edges: Edges
  /** ΔE (CIEDE2000) per pixel, its mean weighted by coverage and its largest where it covers. */
  deltaE: number
  maxDeltaE: number
}

export type CompareImageReport = {
  reference: {
    kind: 'image'
    file: string
    width: number
    height: number
    /** 16 for a 16-bit PNG, read to 8 bits as the film's frames are. */
    bits: 8 | 16
    sha256: string
    /** Whether any pixel is less than opaque: it is measured matted over black (`method.matte`). */
    alpha: boolean
    /** A JPEG's EXIF orientation when it is not 1 (upright): not applied, measured as stored. */
    orientation?: number
  }
  /**
   * How the image was scaled to the film's frame, or `null` when the sizes are the same; `fit` is
   * the fit the person gave, needed when the shapes differ (`aspect: "stretched"`). With
   * `contain` or `cover`: the one `scale` both sides are scaled by, `placed`, the part of the
   * film's frame the image covers, and `masked`, the film's pixels outside it, which no score
   * counts.
   */
  scaled: (Scaling & { fit?: Fit; scale?: number; placed?: Region; masked?: number }) | null
  region: Region | null
  /** How SSIM and the edge score are measured, so a report says what its numbers are. */
  method: typeof METHOD
  regions: {
    file: string
    kind: RegionsFile['kind']
    /** The pixels the file is written in. */
    in: [number, number]
    /** Each region's mask in the film's frame: its box and area in pixels. */
    list: Omit<ScoredRegion, 'mask'>[]
  } | null
  frames: {
    t: number
    ms: number
    psnr: number
    deltaE: number
    maxDeltaE: number
    differing: number
    /** The SSIM map's mean over the frame less a border of 5 pixels, as scikit-image gives it. */
    ssim: number
    edges: Edges
    regions: RegionScore[]
  }[]
}

/**
 * How an image of another shape is fitted to the film's frame: `stretch` scales it to the frame,
 * `contain` fits it whole inside, `cover` fills the frame with it, both centred at one scale.
 */
export type Fit = 'stretch' | 'contain' | 'cover'
const FITS: readonly string[] = ['stretch', 'contain', 'cover'] satisfies Fit[]

/** The clip-only options, by the flag that gives them. */
const CLIP_ONLY = {
  offset: '--offset',
  maxShift: '--max-shift',
  from: '--from',
  to: '--to',
  floor: '--floor',
} as const

/** RGBA of 8 bits a sample from decodeImage's 8 or 16. */
const eightBits = (data: Uint8Array | Uint16Array): Uint8Array =>
  data instanceof Uint8Array ? data : Uint8Array.from(data, (v) => Math.round(v / 257))

/** Whether any pixel of decoded RGBA is less than opaque. */
const hasAlpha = (data: Uint8Array | Uint16Array) => {
  const opaque = data instanceof Uint16Array ? 65535 : 255
  for (let i = 3; i < data.length; i += 4) if ((data[i] as number) < opaque) return true
  return false
}

/** A JPEG's EXIF Orientation (tag 0x0112 in IFD0), or undefined when it has none or is a PNG. */
export const exifOrientation = (b: Uint8Array): number | undefined => {
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  for (let at = 2; at + 4 <= b.length && b[at] === 0xff; ) {
    const marker = b[at + 1] as number
    if (marker === 0xda || marker === 0xd9) return undefined
    const len = v.getUint16(at + 2)
    const body = at + 4
    if (
      marker === 0xe1 &&
      body + 14 <= b.length &&
      new TextDecoder().decode(b.subarray(body, body + 6)) === 'Exif\0\0'
    ) {
      const tiff = body + 6
      const le = b[tiff] === 0x49
      const ifd = tiff + v.getUint32(tiff + 4, le)
      if (ifd + 2 > b.length) return undefined
      const count = v.getUint16(ifd, le)
      for (let i = 0; i < count; i++) {
        const e = ifd + 2 + i * 12
        if (e + 12 > b.length) return undefined
        if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le)
      }
      return undefined
    }
    at = body + len - 2
  }
  return undefined
}

/**
 * Measures the film's final frame at each time against one image (see CompareImageReport). The
 * image is decoded once, as `io.image` decodes it (EXIF orientation not applied), matted over
 * black and scaled to the film's frame once, as a clip's frames are. Throws on bad input.
 */
export const compareWithImage = async (o: CompareFileOptions): Promise<CompareImageReport> => {
  for (const [k, flag] of Object.entries(CLIP_ONLY))
    if (o[k as keyof typeof CLIP_ONLY] !== undefined)
      throw new Error(
        `${flag} reads a clip over time, and ${o.reference} is a still image: it is compared at each time asked for. Give no ${flag}.`,
      )
  if (o.times.length === 0)
    throw new Error(
      `${o.reference} is a still image: give the film's times to compare it at (<t>..., --every or --count).`,
    )
  const { film } = o
  const times = [...new Set(o.times)].sort((a, b) => a - b)
  insideFilm(times, film.duration)
  if (o.limit !== undefined && times.length > o.limit)
    throw new Error(`${times.length} times to render and measure: at most ${o.limit} at once.`)

  const bytes = readFileSync(o.reference)
  const image = decodeImage(bytes, o.reference)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const orientation = exifOrientation(bytes)
  const p = placement(o, image, () => sha256, 'image')
  const theirs = p.part(p.place(eightBits(image.data)))
  const { width: w, height: h } = p.shown

  const frames: CompareImageReport['frames'] = []
  for (let i = 0; i < times.length; i++) {
    const t = times[i] as number
    const started = performance.now()
    const rendered = await film.render(t)
    const ms = performance.now() - started
    const ours = p.part(rendered)
    const { map, ...measured } = structure(ours, theirs, w, h, p.found, p.shown)
    frames.push({ t: Number(t.toFixed(6)), ms, ...compareFrames(ours, theirs), ...measured })
    await o.frame?.({
      index: i,
      count: times.length,
      t: Number(t.toFixed(6)),
      pixels: row([ours, theirs, heatMap(map)], w, h),
      width: w * 3,
      height: h,
    })
  }
  return {
    reference: {
      kind: 'image',
      file: o.reference,
      width: image.width,
      height: image.height,
      bits: image.bits,
      sha256,
      alpha: hasAlpha(image.data),
      ...(orientation === undefined || orientation === 1 ? {} : { orientation }),
    },
    scaled: p.scaled,
    region: p.region,
    method: METHOD,
    regions: p.regions,
    frames,
  }
}

/** How SSIM and the edge score are measured, as a report names them. */
export const METHOD = { ssim: SSIM, edges: EDGES, matte: 'black' } as const

/** A reference fitted to the film's frame, the part of it measured, and its regions. */
export type Placement = {
  scaled: CompareImageReport['scaled']
  /** A reference frame (RGBA, of the reference's size) in the film's frame: scaled, or placed. */
  place: (px: Uint8Array) => Uint8Array
  /** A frame of the film's size cut to the part measured, `shown`. */
  part: (px: Uint8Array) => Uint8Array
  shown: Region
  /** The part asked for with --region, cut to the reference; `null` without one. */
  region: Region | null
  found: RegionsFile | null
  regions: CompareImageReport['regions']
}

/**
 * How a reference of `ref`'s size is fitted to the film's frame (`o.fit`), the part of the frame
 * measured (`o.region`, cut to what the reference covers) and the regions of `o.regions` in it.
 * An image of another shape needs a fit; a clip of another shape is stretched without one, as it
 * was before fits. `sha256` is the reference's, read only for a regions artifact. Throws on bad
 * input, also when the part is smaller than SSIM's window.
 */
export const placement = (
  o: CompareFileOptions,
  ref: { width: number; height: number },
  sha256: () => string,
  kind: 'image' | 'clip',
): Placement => {
  if (o.region && o.regions !== undefined)
    throw new Error(
      '--regions scores parts of the whole frame: give it without --region, or a box in it.',
    )
  if (o.fit !== undefined && !FITS.includes(o.fit))
    throw new Error(`--fit is stretch, contain or cover, not ${JSON.stringify(o.fit)}.`)
  const { film } = o
  const { width, height } = film
  const scaled = scaling(ref, film)
  if (kind === 'image' && scaled?.aspect === 'stretched' && o.fit === undefined)
    throw new Error(
      `${o.reference} is ${ref.width}×${ref.height} and the film is ${width}×${height}, another shape: give --fit stretch, contain or cover to fit it to the frame.`,
    )
  // contain and cover place the reference at one scale; the film's pixels it does not cover are
  // not measured: every score is over `seen`, the part it covers.
  const box =
    scaled && (o.fit === 'contain' || o.fit === 'cover') ? fitBox(ref, film, o.fit) : undefined
  const seen = box ? inFrame(box, width, height) : { x: 0, y: 0, width, height }
  const found = o.regions
    ? loadRegionsFile(
        o.regions,
        { file: o.reference, width: ref.width, height: ref.height, sha256 },
        film,
        o.within,
        box && { box, seen },
      )
    : null
  const asked = o.region
    ? crop(new Uint8Array(width * height * 4), film, o.region).region
    : undefined
  const shown = asked ? overlap(asked, seen) : seen
  if (!shown)
    throw new Error(
      `--region ${JSON.stringify(asked)} is outside the ${kind}, which covers ${seen.width}×${seen.height} at ${seen.x},${seen.y} of the frame (--fit ${o.fit}).`,
    )
  if (shown.width < SSIM.size || shown.height < SSIM.size)
    throw new Error(
      `SSIM needs at least ${SSIM.size}×${SSIM.size} pixels, its window: the part measured is ${shown.width}×${shown.height}.`,
    )
  const all = shown.width === width && shown.height === height
  return {
    scaled: scaled && {
      ...scaled,
      ...(o.fit === undefined ? {} : { fit: o.fit as Fit }),
      ...(box
        ? { scale: box.scale, placed: seen, masked: width * height - seen.width * seen.height }
        : {}),
    },
    place: (px) =>
      box
        ? placeFrame(px, ref.width, ref.height, width, height, box)
        : scaleFrame(px, ref.width, ref.height, width, height),
    part: (px) => (all ? px : crop(px, film, shown).pixels),
    shown,
    region: asked ? shown : null,
    found,
    regions: found && {
      file: found.file,
      kind: found.kind,
      in: found.in,
      list: found.regions.map(({ mask: _, ...q }) => q),
    },
  }
}

/** What structure measures at one time: SSIM, the edge score, and each region's scores. */
export type Structure = { ssim: number; edges: Edges; regions: RegionScore[] }

/**
 * SSIM, the edge score and each region's scores between the film's part measured and the
 * reference's (RGBA, `w`×`h`, the part `shown` of the frame), and the SSIM map for the heat map.
 */
export const structure = (
  ours: Uint8Array,
  theirs: Uint8Array,
  w: number,
  h: number,
  found: RegionsFile | null,
  shown: Region,
): Structure & { map: Float64Array } => {
  const ourLuma = luma(ours)
  const theirLuma = luma(theirs)
  const s = ssim(ourLuma, theirLuma, w, h)
  const ourEdges = sobel(ourLuma, w, h)
  const theirEdges = sobel(theirLuma, w, h)
  const dE = found ? deltaEs(ours, theirs) : undefined
  return {
    map: s.map,
    ssim: s.mean,
    edges: edges(ourEdges, theirEdges, w, everywhere(w, h)),
    regions: (found?.regions ?? []).map((q) => {
      // A region's mask in the part measured, which is cut to it.
      const m = { ...q.mask, x: q.mask.x - shown.x, y: q.mask.y - shown.y }
      return {
        id: q.id,
        ssim: maskedMean(s.map, w, m) as number,
        edges: edges(ourEdges, theirEdges, w, m),
        deltaE: maskedMean(dE as Float64Array, w, m) as number,
        maxDeltaE: maskedMax(dE as Float64Array, w, m) as number,
      }
    }),
  }
}

/** The part two boxes share, or undefined when none. */
const overlap = (a: Region, b: Region): Region | undefined => {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const width = Math.min(a.x + a.width, b.x + b.width) - x
  const height = Math.min(a.y + a.height, b.y + b.height) - y
  return width > 0 && height > 0 ? { x, y, width, height } : undefined
}

const score = (s: number) => s.toFixed(3)
const edgeText = (e: Edges) => (e.agreement === null ? 'no edges' : `edges ${score(e.agreement)}`)

/** How the image was fitted to the frame, when the shapes differ or a fit was given. */
export const fitText = (s: NonNullable<CompareImageReport['scaled']>): string => {
  if (s.placed && s.scale !== undefined && s.masked !== undefined)
    return `, --fit ${s.fit} at ×${Number(s.scale.toFixed(4))}: it covers ${s.placed.width}×${s.placed.height} at ${s.placed.x},${s.placed.y}, and the ${s.masked} pixels outside it are not scored`
  return s.aspect === 'stretched'
    ? `, stretched by --fit ${s.fit}: the frames have other shapes`
    : ''
}

/** The image report as lines: the reference, and where its regions came from. */
export const imageSummaryLines = (r: CompareImageReport): string[] => {
  const ref = r.reference
  const lines = [
    `reference: ${ref.width}×${ref.height} image${ref.bits === 16 ? ' (16 bits, read to 8)' : ''}${
      r.scaled
        ? `, scaled to ${r.scaled.to.join('×')} (${r.scaled.filter}${fitText(r.scaled)})`
        : ''
    }${r.region ? `; measured in ${r.region.width}×${r.region.height} at ${r.region.x},${r.region.y}` : ''}`,
  ]
  if (r.regions)
    lines.push(
      `regions: ${r.regions.list.map((q) => q.id).join(', ')} (${r.regions.kind} in ${r.regions.in.join('×')})`,
    )
  return lines
}

/** One time's lines: the whole frame's measurements, then each region's, indented. */
export const imageFrameLines = (f: CompareImageReport['frames'][number]): string[] => {
  const psnr = Number.isFinite(f.psnr) ? `PSNR ${f.psnr.toFixed(2)} dB` : 'identical'
  const [whole, ...regions] = structureLines(f)
  return [
    `${f.ms.toFixed(0)} ms  ${psnr}, mean ΔE ${f.deltaE.toFixed(3)} (max ${f.maxDeltaE.toFixed(2)}), ${f.differing} pixels differ; ${whole}`,
    ...regions,
  ]
}

/** The whole frame's SSIM and edge score, then each region's line, indented. */
export const structureLines = (f: Structure): [string, ...string[]] => [
  `SSIM ${score(f.ssim)}, ${edgeText(f.edges)}`,
  ...f.regions.map(
    (q) =>
      `  ${q.id}: SSIM ${score(q.ssim)}, ${edgeText(q.edges)}, mean ΔE ${q.deltaE.toFixed(3)} (max ${q.maxDeltaE.toFixed(2)})`,
  ),
]
