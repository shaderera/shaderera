// `still --compare-file <image>`: the film's still at each time asked for, measured against a
// reference image (a poster, a screenshot, a hero): PSNR and ΔE as `--compare` gives them, SSIM
// and an edge score, for the whole frame and for each region of `--regions`. It measures and never
// judges (decisions 0011 and 0032): there is no pass or fail.
import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { compareFrames, deltaEs } from '../review/compare.ts'
import { row, type Scaling, scaleFrame, scaling } from '../review/reference.ts'
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
  }
  /**
   * How the image was scaled to the film's frame, or `null` when the sizes are the same; `fit` is
   * the fit the person gave, needed when the shapes differ (`aspect: "stretched"`).
   */
  scaled: (Scaling & { fit?: Fit }) | null
  region: Region | null
  /** How SSIM and the edge score are measured, so a report says what its numbers are. */
  method: { ssim: typeof SSIM; edges: typeof EDGES }
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

/** How an image of another shape is fitted to the film's frame. Only `stretch` so far. */
export type Fit = 'stretch'
const FITS: readonly string[] = ['stretch'] satisfies Fit[]

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
  if (o.region && o.regions !== undefined)
    throw new Error(
      '--regions scores parts of the whole frame: give it without --region, or a box in it.',
    )
  const { film } = o
  const { width, height } = film
  const times = [...new Set(o.times)].sort((a, b) => a - b)
  insideFilm(times, film.duration)
  if (o.limit !== undefined && times.length > o.limit)
    throw new Error(`${times.length} times to render and measure: at most ${o.limit} at once.`)

  const bytes = readFileSync(o.reference)
  const image = decodeImage(bytes, o.reference)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (o.fit !== undefined && !FITS.includes(o.fit))
    throw new Error(`--fit is ${FITS.join(' or ')}, not ${JSON.stringify(o.fit)}.`)
  const scaled = scaling(image, film)
  if (scaled?.aspect === 'stretched' && o.fit === undefined)
    throw new Error(
      `${o.reference} is ${image.width}×${image.height} and the film is ${width}×${height}, another shape: give --fit stretch to stretch it to the frame.`,
    )
  const whole = scaleFrame(eightBits(image.data), image.width, image.height, width, height)
  const found = o.regions
    ? loadRegionsFile(
        o.regions,
        { file: o.reference, width: image.width, height: image.height, sha256 },
        film,
        o.within,
      )
    : null

  const part = (px: Uint8Array) => (o.region ? crop(px, film, o.region).pixels : px)
  const region = o.region ? crop(whole, film, o.region).region : null
  const shown = region ?? { x: 0, y: 0, width, height }
  if (shown.width < SSIM.size || shown.height < SSIM.size)
    throw new Error(
      `SSIM needs at least ${SSIM.size}×${SSIM.size} pixels, its window: the part measured is ${shown.width}×${shown.height}.`,
    )
  const { width: w, height: h } = shown
  const theirs = part(whole)
  const theirLuma = luma(theirs)
  const theirEdges = sobel(theirLuma, w, h)
  const all = everywhere(w, h)

  const frames: CompareImageReport['frames'] = []
  for (let i = 0; i < times.length; i++) {
    const t = times[i] as number
    const started = performance.now()
    const rendered = await film.render(t)
    const ms = performance.now() - started
    const ours = part(rendered)
    const ourLuma = luma(ours)
    const s = ssim(ourLuma, theirLuma, w, h)
    const ourEdges = sobel(ourLuma, w, h)
    const dE = found ? deltaEs(ours, theirs) : undefined
    frames.push({
      t: Number(t.toFixed(6)),
      ms,
      ...compareFrames(ours, theirs),
      ssim: s.mean,
      edges: edges(ourEdges, theirEdges, w, all),
      regions: (found?.regions ?? []).map((q) => ({
        id: q.id,
        ssim: maskedMean(s.map, w, q.mask) as number,
        edges: edges(ourEdges, theirEdges, w, q.mask),
        deltaE: maskedMean(dE as Float64Array, w, q.mask) as number,
        maxDeltaE: maskedMax(dE as Float64Array, w, q.mask) as number,
      })),
    })
    await o.frame?.({
      index: i,
      count: times.length,
      t: Number(t.toFixed(6)),
      pixels: row([ours, theirs, heatMap(s.map)], w, h),
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
    },
    scaled: scaled && { ...scaled, ...(o.fit === undefined ? {} : { fit: o.fit as Fit }) },
    region,
    method: { ssim: SSIM, edges: EDGES },
    regions: found && {
      file: found.file,
      kind: found.kind,
      in: found.in,
      list: found.regions.map(({ mask: _, ...q }) => q),
    },
    frames,
  }
}

const score = (s: number) => s.toFixed(3)
const edgeText = (e: Edges) => (e.agreement === null ? 'no edges' : `edges ${score(e.agreement)}`)

/** The image report as lines: the reference, and where its regions came from. */
export const imageSummaryLines = (r: CompareImageReport): string[] => {
  const ref = r.reference
  const lines = [
    `reference: ${ref.width}×${ref.height} image${ref.bits === 16 ? ' (16 bits, read to 8)' : ''}${
      r.scaled
        ? `, scaled to ${r.scaled.to.join('×')} (${r.scaled.filter}${r.scaled.aspect === 'stretched' ? `, stretched by --fit ${r.scaled.fit}: the frames have other shapes` : ''})`
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
  return [
    `${f.ms.toFixed(0)} ms  ${psnr}, mean ΔE ${f.deltaE.toFixed(3)} (max ${f.maxDeltaE.toFixed(2)}), ${f.differing} pixels differ; SSIM ${score(f.ssim)}, ${edgeText(f.edges)}`,
    ...f.regions.map(
      (q) =>
        `  ${q.id}: SSIM ${score(q.ssim)}, ${edgeText(q.edges)}, mean ΔE ${q.deltaE.toFixed(3)} (max ${q.maxDeltaE.toFixed(2)})`,
    ),
  ]
}
