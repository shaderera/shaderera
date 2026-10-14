// Paper pieces for collage: a print on paper, cut out with a knife or scissors or torn out along any
// shape, or a rectangle with each side cut straight or torn. The paper has a stock's colour, a tone
// that wanders, fibre, and a cut face that catches shadow at its edge. Built once (in open) from a
// seed: the same piece every time. Lengths are output pixels; `scale` is how many output pixels one
// raster pixel becomes, so a piece built from a 4000 px photo drawn small still tears at the size asked.

type Io = { canvas(width: number, height: number): OffscreenCanvas }
type RGB = readonly [number, number, number]

/**
 * The print's colour at a raster pixel (straight sRGB 0–255), or undefined where it has none, which
 * leaves bare paper. A cut-out with `around: 'print'` also asks for the pixels of its border, outside
 * 0..width and 0..height.
 */
export type Print = (x: number, y: number) => RGB | undefined

/** A built piece: draw `canvas` at (−margin, −margin) in the raster's coordinates. */
export type Piece = { canvas: OffscreenCanvas; margin: number }

/** Some paper stocks' colours, to start from: any [r, g, b] will do. */
export const PAPERS = {
  white: [246, 245, 241],
  coated: [250, 250, 252],
  cream: [242, 234, 214],
  newsprint: [222, 218, 206],
  kraft: [186, 156, 116],
  black: [30, 29, 28],
} as const satisfies Record<string, RGB>

type Paper = {
  /** Output pixels per raster pixel (1). */
  scale?: number
  seed?: number
  /** The paper's colour where no print covers it (PAPERS.white). */
  paper?: RGB
  /** How far the paper's tone darkens across the sheet, 0..1 (0.06). */
  shade?: number
  /** Fibre: how far each pixel's colour wanders, in code values (6). */
  grain?: number
  /** How dark the cut face is at the piece's very edge, 0..1 (0.3). */
  edgeShade?: number
}

type Tearing = {
  /** How far a torn line wanders in and out, px (7). */
  depth?: number
  /** The white core a tear shows beyond the print, px on average (5). */
  rim?: number
  /** The paper fibre at a torn edge, px (1.5). */
  fibre?: number
}

export type Cutout = Paper &
  Tearing & {
    width: number
    height: number
    /** The shape's coverage, 0–255, `width × height`, rows from the top. */
    alpha: Uint8Array
    print: Print
    /** How far the piece reaches beyond the shape, px (0). */
    border?: number
    /** What the border shows: bare paper (a white edge), or the print going on past the shape ('paper'). */
    around?: 'paper' | 'print'
    /**
     * The piece's outer edge: a knife's smooth curve ('cut'), scissors' straight snips meeting at
     * corners ('scissors'), or torn by hand ('torn') ('cut').
     */
    edge?: 'cut' | 'scissors' | 'torn'
    /** How much a cut border's width wanders, 0..1 (0.35). */
    wobble?: number
    /** The distance between the edge's bends, px (70 cut, 60 torn). */
    wavelength?: number
    /** How far a scissors' straight snip may stray from the outline, px: more, longer snips (2.5). */
    snip?: number
    /** Which separate pieces of the shape to keep: all, the largest, or those of at least `minArea` px² ('all'). */
    pieces?: 'all' | 'largest' | { minArea: number }
    /** The shape's holes: kept, filled, or filled up to `maxArea` px² ('keep'). */
    holes?: 'keep' | 'fill' | { maxArea: number }
    /** Cut away parts thinner than twice this, px: whiskers, hair, stray strands; it rounds sharper corners too (0). */
    smooth?: number
    /** Fade the print in over this many px inside its edge, to lay a piece into a photo unseen (0). */
    feather?: number
  }

export type Side = 'cut' | 'torn'

export type Strip = Paper &
  Tearing & {
    width: number
    height: number
    print: Print
    sides: { left: Side; right: Side; top: Side; bottom: Side }
    /** The distance between a tear's big bends, px (60). */
    wavelength?: number
  }

// Value noise, −1..1, from a seed: one dimension along a straight torn side, two around a shape.
const hash = (seed: number, i: number, j = 0) => {
  let h = (seed * 374761393 + i * 668265263 + j * 2246822519) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (((h ^ (h >>> 16)) >>> 0) / 4294967295) * 2 - 1
}
const smoothstep = (t: number) => t * t * (3 - 2 * t)
const noise1 = (seed: number, x: number) => {
  const i = Math.floor(x)
  return hash(seed, i) + (hash(seed, i + 1) - hash(seed, i)) * smoothstep(x - i)
}
const noise2 = (seed: number, x: number, y: number) => {
  const i = Math.floor(x)
  const j = Math.floor(y)
  const u = smoothstep(x - i)
  const a = hash(seed, i, j) + (hash(seed, i + 1, j) - hash(seed, i, j)) * u
  const b = hash(seed, i, j + 1) + (hash(seed, i + 1, j + 1) - hash(seed, i, j + 1)) * u
  return a + (b - a) * smoothstep(y - j)
}
/** A torn line along a side: slow bends, smaller bites, then fibre-scale jitter. */
const tear1 = (seed: number, x: number, wavelength: number) =>
  noise1(seed, x / wavelength) * 0.6 +
  noise1(seed + 1, (x * 3.1) / wavelength) * 0.3 +
  noise1(seed + 2, (x * 9.7) / wavelength) * 0.1
/** The same around a shape, where there is no "along": the bends are a field over the plane. */
const tear2 = (seed: number, x: number, y: number, wavelength: number) =>
  noise2(seed, x / wavelength, y / wavelength) * 0.6 +
  noise2(seed + 1, (x * 3.1) / wavelength, (y * 3.1) / wavelength) * 0.3 +
  noise2(seed + 2, (x * 9.7) / wavelength, (y * 9.7) / wavelength) * 0.1

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

/** Squared distance to the nearest set pixel, exact (Felzenszwalb and Huttenlocher). */
const distance = (on: Uint8Array, w: number, h: number) => {
  const INF = 1e20
  const out = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) out[i] = on[i] ? 0 : INF
  const n = Math.max(w, h)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  const pass = (len: number) => {
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < len; q++) {
      let s: number
      for (;;) {
        const p = v[k] as number
        s = ((f[q] as number) + q * q - ((f[p] as number) + p * p)) / (2 * q - 2 * p)
        if (s > (z[k] as number) || k === 0) break
        k--
      }
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < len; q++) {
      while ((z[k + 1] as number) < q) k++
      const p = v[k] as number
      d[q] = (q - p) * (q - p) + (f[p] as number)
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x] as number
    pass(h)
    for (let y = 0; y < h; y++) out[y * w + x] = d[y] as number
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x] as number
    pass(w)
    for (let x = 0; x < w; x++) out[y * w + x] = d[x] as number
  }
  return out
}

/** Connected runs of `value` (4-neighbours): each pixel's label (0 for other values) and each label's size. */
const components = (field: Uint8Array, value: number, w: number, h: number) => {
  const label = new Int32Array(w * h)
  const sizes = [0]
  const stack = new Int32Array(w * h)
  for (let start = 0; start < w * h; start++) {
    if (field[start] !== value || label[start] !== 0) continue
    const id = sizes.length
    let n = 0
    let size = 0
    const visit = (j: number) => {
      if (label[j] === 0 && field[j] === value) {
        label[j] = id
        stack[n++] = j
      }
    }
    visit(start)
    while (n > 0) {
      const i = stack[--n] as number
      size++
      const x = i % w
      if (x > 0) visit(i - 1)
      if (x < w - 1) visit(i + 1)
      if (i >= w) visit(i - w)
      if (i < w * (h - 1)) visit(i + w)
    }
    sizes.push(size)
  }
  return { label, sizes }
}

/** The eight neighbours, clockwise on screen (rows run down), from east. */
const AROUND = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
] as const

/** The outline of the piece `start` begins (its first pixel in scan order), pixel centres in order. */
const outline = (on: Uint8Array, w: number, h: number, start: number) => {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && on[y * w + x] === 1
  let x = start % w
  let y = Math.floor(start / w)
  const sx = x
  const sy = y
  const points: [number, number][] = [[x + 0.5, y + 0.5]]
  let back = 4 // the start's west neighbour is empty: it is the first in scan order
  let first = -1
  for (let n = 0; n < 4 * w * h; n++) {
    let found = -1
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8
      const [dx, dy] = AROUND[d] as readonly [number, number]
      if (inside(x + dx, y + dy)) {
        found = d
        break
      }
    }
    if (found < 0) break
    if (first < 0) first = found
    else if (x === sx && y === sy && found === first) break
    const [bx, by] = AROUND[(found + 7) % 8] as readonly [number, number]
    const [dx, dy] = AROUND[found] as readonly [number, number]
    x += dx
    y += dy
    back = AROUND.findIndex(([ax, ay]) => ax === bx - dx && ay === by - dy)
    points.push([x + 0.5, y + 0.5])
  }
  if (points.length > 1) points.pop()
  return points
}

/** An outline as straight lines that stray no further than `tolerance` from it (Ramer–Douglas–Peucker). */
const straighten = (points: [number, number][], tolerance: number) => {
  if (points.length < 4) return points
  // Split the closed outline at the point farthest from the first, and straighten each half.
  const [x0, y0] = points[0] as [number, number]
  let far = 0
  let most = -1
  points.forEach(([x, y], i) => {
    const d = (x - x0) ** 2 + (y - y0) ** 2
    if (d > most) [most, far] = [d, i]
  })
  const keep = new Uint8Array(points.length + 1)
  keep[0] = keep[far] = keep[points.length] = 1
  const at = (i: number) => points[i % points.length] as [number, number]
  const spans: [number, number][] = [
    [0, far],
    [far, points.length],
  ]
  while (spans.length > 0) {
    const [a, b] = spans.pop() as [number, number]
    const [ax, ay] = at(a)
    const [bx, by] = at(b)
    const len = Math.hypot(bx - ax, by - ay) || 1
    let worst = -1
    let index = -1
    for (let i = a + 1; i < b; i++) {
      const [px, py] = at(i)
      const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len
      if (d > worst) [worst, index] = [d, i]
    }
    if (worst > tolerance) {
      keep[index] = 1
      spans.push([a, index], [index, b])
    }
  }
  return points.filter((_, i) => keep[i] === 1)
}

/** Coverage 0..1 of the polygons (even-odd), four rows of samples a pixel, exact across each row. */
const fill = (polygons: readonly (readonly [number, number][])[], w: number, h: number) => {
  const cover = new Float32Array(w * h)
  const SUB = 4
  const edges = polygons.flatMap((p) =>
    p.map((a, i) => [a, p[(i + 1) % p.length] as [number, number]] as const),
  )
  const xs: number[] = []
  for (let y = 0; y < h; y++)
    for (let s = 0; s < SUB; s++) {
      const sy = y + (s + 0.5) / SUB
      xs.length = 0
      for (const [[ax, ay], [bx, by]] of edges)
        if (ay <= sy !== by <= sy) xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax))
      xs.sort((a, b) => a - b)
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, xs[k] as number)
        const b = Math.min(w, xs[k + 1] as number)
        for (let px = Math.floor(a); px < b; px++) {
          const part = Math.min(b, px + 1) - Math.max(a, px)
          if (part > 0) cover[y * w + px] = (cover[y * w + px] as number) + part / SUB
        }
      }
    }
  return cover
}

/** The shape as the piece is cut: thin parts cut away, pieces kept, holes filled, as asked. */
const shapeOf = (on: Uint8Array, w: number, h: number, o: Cutout, scale: number) => {
  let shape = on
  const r = (o.smooth ?? 0) / scale
  if (r > 0) {
    // An opening: erode by r, then grow back by r. Anything thinner than 2r does not come back.
    const out = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) out[i] = shape[i] ? 0 : 1
    const inner = distance(out, w, h)
    const core = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) core[i] = (inner[i] as number) > r * r ? 1 : 0
    const grown = distance(core, w, h)
    shape = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) shape[i] = on[i] && (grown[i] as number) <= r * r ? 1 : 0
  }
  const pieces = o.pieces ?? 'all'
  if (pieces !== 'all') {
    const { label, sizes } = components(shape, 1, w, h)
    const largest = sizes.indexOf(Math.max(0, ...sizes.slice(1)))
    const min = typeof pieces === 'object' ? pieces.minArea / (scale * scale) : 0
    const keep = sizes.map((s, id) => id > 0 && (pieces === 'largest' ? id === largest : s >= min))
    shape = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) shape[i] = keep[label[i] as number] ? 1 : 0
  }
  const holes = o.holes ?? 'keep'
  if (holes !== 'keep') {
    // A hole is empty space the raster's edge cannot reach.
    const { label, sizes } = components(shape, 0, w, h)
    const outside = new Set<number>()
    for (let x = 0; x < w; x++)
      outside.add(label[x] as number).add(label[(h - 1) * w + x] as number)
    for (let y = 0; y < h; y++)
      outside.add(label[y * w] as number).add(label[y * w + w - 1] as number)
    const max = typeof holes === 'object' ? holes.maxArea / (scale * scale) : Infinity
    const filled = shape === on ? new Uint8Array(shape) : shape
    for (let i = 0; i < w * h; i++) {
      const id = label[i] as number
      if (id > 0 && !outside.has(id) && (sizes[id] as number) <= max) filled[i] = 1
    }
    shape = filled
  }
  return shape
}

const toCanvas = (io: Io, w: number, h: number, px: Uint8ClampedArray) => {
  const c = io.canvas(w, h)
  const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D
  const img = g.createImageData(w, h)
  img.data.set(px)
  g.putImageData(img, 0, 0)
  return c
}

/**
 * The piece's pixels from its print's and its paper's coverage: the paper's stock, its tone over
 * the sheet and its fibre where no print covers it, then the cut face darkening the outermost px.
 */
const finish = (
  io: Io,
  w: number,
  h: number,
  ink: Float32Array,
  paper: Float32Array,
  print: (x: number, y: number) => RGB | undefined,
  o: Paper,
  scale: number,
  face: boolean,
) => {
  const stock = o.paper ?? PAPERS.white
  const seed = o.seed ?? 1
  const shade = unit('shade', o.shade ?? 0.06)
  const grain = amount('grain', o.grain ?? 6)
  const edgeShade = face ? unit('edgeShade', o.edgeShade ?? 0.3) : 0
  const sheet = 160 / scale
  const fine = 0.7 * scale
  const coarse = 0.23 * scale
  const empty = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++)
    empty[i] = Math.max(ink[i] as number, paper[i] as number) < 0.5 ? 1 : 0
  const toEdge = edgeShade > 0 ? distance(empty, w, h) : undefined
  const reach = 1.2 / scale
  const px = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const k = ink[i] as number
      const a = Math.max(k, paper[i] as number)
      if (a <= 0) continue
      // Light falls unevenly on the sheet: the tone only ever darkens, so white paper never clips.
      const tone = 1 - shade * (0.5 + 0.5 * noise2(seed + 11, x / sheet, y / sheet))
      const fibre =
        grain *
        (0.6 * noise2(seed + 7, x * fine, y * fine) +
          0.4 * noise2(seed + 8, x * coarse, y * coarse))
      const rgb = k > 0 ? print(x, y) : undefined
      const p = rgb ? k / a : 0
      const dark = toEdge ? 1 - edgeShade * Math.exp(-Math.sqrt(toEdge[i] as number) / reach) : 1
      for (let c = 0; c < 3; c++)
        px[i * 4 + c] =
          ((rgb ? (rgb[c] as number) : 0) * p + ((stock[c] as number) * tone + fibre) * (1 - p)) *
          dark
      px[i * 4 + 3] = a * 255
    }
  return toCanvas(io, w, h, px)
}

const size = (name: string, n: number) => {
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`${name} must be a whole number of pixels, at least 1 (got ${n})`)
  return n
}
const positive = (name: string, n: number) => {
  if (!(n > 0) || !Number.isFinite(n)) throw new Error(`${name} must be above 0 (got ${n})`)
  return n
}
const amount = (name: string, n: number) => {
  if (!(n >= 0) || !Number.isFinite(n)) throw new Error(`${name} must be 0 or more (got ${n})`)
  return n
}
const unit = (name: string, n: number) => {
  if (!(n >= 0 && n <= 1)) throw new Error(`${name} must be from 0 to 1 (got ${n})`)
  return n
}

/**
 * A shape cut or torn out of its print. With no border and a knife's cut, the piece follows the
 * mask's own soft edge. A border reaches `border` px past the shape, showing bare paper or more of
 * the print. Scissors cut straight snips round it (and cannot cut holes: they are filled). A torn
 * edge wanders, shows the paper's white core beyond the print and breaks into fibre, and may tear
 * into the shape where the border is narrower than `depth`.
 */
export const cutout = (io: Io, o: Cutout): Piece => {
  const w = size('width', o.width)
  const h = size('height', o.height)
  if (o.alpha.length !== w * h)
    throw new Error(`alpha has ${o.alpha.length} values, not width × height = ${w * h}`)
  const scale = positive('scale', o.scale ?? 1)
  const edge = o.edge ?? 'cut'
  const torn = edge === 'torn'
  const scissors = edge === 'scissors'
  const border = amount('border', o.border ?? 0) / scale
  const wobble = unit('wobble', o.wobble ?? 0.35)
  const wl = positive('wavelength', o.wavelength ?? (torn ? 60 : 70)) / scale
  const depth = amount('depth', o.depth ?? 7) / scale
  const rim = amount('rim', o.rim ?? 5) / scale
  const fibre = amount('fibre', o.fibre ?? 1.5) / scale
  const snip = positive('snip', o.snip ?? 2.5) / scale
  const feather = amount('feather', o.feather ?? 0) / scale
  amount('smooth', o.smooth ?? 0)
  const seed = o.seed ?? 1
  const printAround = (o.around ?? 'paper') === 'print'
  const reachMost = torn ? border + depth + fibre : border * (1 + wobble)
  const m = Math.ceil(reachMost) + 2
  const W = w + 2 * m
  const H = h + 2 * m
  const soft = new Float32Array(W * H)
  const on = new Uint8Array(W * H)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = (o.alpha[y * w + x] as number) / 255
      soft[(y + m) * W + x + m] = a
      on[(y + m) * W + x + m] = a > 0.5 ? 1 : 0
    }
  const shaped =
    (o.smooth ?? 0) > 0 || (o.pieces ?? 'all') !== 'all' || (o.holes ?? 'keep') !== 'keep'
  const shape = shaped ? shapeOf(on, W, H, o, scale) : on
  const ink = new Float32Array(W * H)
  const paper = new Float32Array(W * H)
  const print = (x: number, y: number) => o.print(x - m, y - m)
  // A feathered piece lays into the photo: it has no cut face to catch shadow.
  const face = feather === 0

  // The mask's own edge: no paper, the soft coverage as it is.
  if (border === 0 && edge === 'cut' && !shaped && feather === 0) {
    ink.set(soft)
    return { canvas: finish(io, W, H, ink, paper, print, o, scale, face), margin: m }
  }

  // Signed distance to the shape's edge: positive outside, negative inside.
  const outside = distance(shape, W, H)
  const empty = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) empty[i] = shape[i] ? 0 : 1
  const inside = distance(empty, W, H)
  const sdAt = (i: number) =>
    shape[i] ? 0.5 - Math.sqrt(inside[i] as number) : Math.sqrt(outside[i] as number) - 0.5
  const cutReach = (x: number, y: number) => border * (1 + wobble * noise2(seed, x / wl, y / wl))

  // Scissors: the piece's outline as straight snips, each with a little of the hand in it.
  let snipped: Float32Array | undefined
  if (scissors) {
    const piece = new Uint8Array(W * H)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        piece[y * W + x] = cutReach(x, y) + 0.5 - sdAt(y * W + x) > 0 ? 1 : 0
    const { label, sizes } = components(piece, 1, W, H)
    const starts = new Map<number, number>()
    for (let i = 0; i < W * H; i++)
      if (label[i] && !starts.has(label[i] as number)) starts.set(label[i] as number, i)
    const polygons = [...starts.entries()]
      .filter(([id]) => (sizes[id] as number) > 2)
      .map(([id, start]) =>
        straighten(outline(piece, W, H, start), snip).map(([x, y], k): [number, number] => [
          x + hash(seed + 21, id, k) * snip * 0.35,
          y + hash(seed + 22, id, k) * snip * 0.35,
        ]),
      )
    snipped = fill(polygons, W, H)
  }

  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const sd = sdAt(i)
      // The shape's own print: its soft coverage where the mask has it, full where a hole was filled,
      // and the soft fringe just outside a kept edge.
      const own = shape[i]
        ? on[i]
          ? Math.max(0.5, soft[i] as number)
          : 1
        : sd < 1.5
          ? (soft[i] as number)
          : 0
      const fade = feather > 0 ? clamp01((-sd + 0.5) / feather) : 1
      if (snipped) {
        const cut = snipped[i] as number
        ink[i] = (printAround || border === 0 ? cut : Math.min(own, cut)) * fade
        paper[i] = border > 0 ? cut : 0
        continue
      }
      const reach = torn
        ? border +
          depth * tear2(seed, x, y, wl) +
          fibre * noise2(seed + 9, x / (fibre + 0.5), y / (fibre + 0.5))
        : cutReach(x, y)
      const core = torn
        ? rim * (0.6 + 0.8 * Math.abs(noise2(seed + 5, x / (wl * 0.5), y / (wl * 0.5))))
        : 0
      const limit = clamp01(reach - core - sd + 0.5)
      ink[i] = (printAround ? limit : Math.min(own, torn ? limit : 1)) * fade
      // Paper shows only where the piece has some: a border, or the white core of a tear.
      paper[i] = border > 0 || torn ? clamp01(reach - sd + 0.5) : 0
    }
  return { canvas: finish(io, W, H, ink, paper, print, o, scale, face), margin: m }
}

/**
 * A `width × height` rectangle of print on paper with each side cut straight or torn. A torn side
 * wanders, shows the paper's white core beyond the print, and breaks into fibre.
 */
export const strip = (io: Io, o: Strip): Piece => {
  const w = size('width', o.width)
  const h = size('height', o.height)
  const scale = positive('scale', o.scale ?? 1)
  const depth = amount('depth', o.depth ?? 7) / scale
  const rim = amount('rim', o.rim ?? 5) / scale
  const fibre = amount('fibre', o.fibre ?? 1.5) / scale
  const wl = positive('wavelength', o.wavelength ?? 60) / scale
  const seed = o.seed ?? 1
  const m = Math.ceil(depth + fibre) + 2
  const W = w + 2 * m
  const H = h + 2 * m
  const sides = [
    {
      side: o.sides.left,
      seed: seed * 4,
      inward: (x: number) => x,
      along: (_: number, y: number) => y,
    },
    {
      side: o.sides.right,
      seed: seed * 4 + 1,
      inward: (x: number) => w - x,
      along: (_: number, y: number) => y,
    },
    {
      side: o.sides.top,
      seed: seed * 4 + 2,
      inward: (_: number, y: number) => y,
      along: (x: number) => x,
    },
    {
      side: o.sides.bottom,
      seed: seed * 4 + 3,
      inward: (_: number, y: number) => h - y,
      along: (x: number) => x,
    },
  ]
  const ink = new Float32Array(W * H)
  const paper = new Float32Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const sx = x - m + 0.5
      const sy = y - m + 0.5
      // Distance inside the paper and inside the print: the nearest side decides.
      let onPaper = Infinity
      let onPrint = Infinity
      for (const s of sides) {
        const d = s.inward(sx, sy)
        if (s.side === 'cut') {
          onPaper = Math.min(onPaper, d)
          onPrint = Math.min(onPrint, d)
          continue
        }
        const a = s.along(sx, sy)
        const line = d + depth * tear1(s.seed, a, wl)
        const hair = fibre * noise2(s.seed + 9, a / (fibre * 0.6 + 0.5), d / (fibre * 2 + 1))
        onPaper = Math.min(onPaper, line + hair)
        onPrint = Math.min(
          onPrint,
          line - rim * (0.6 + 0.8 * Math.abs(noise1(s.seed + 5, a / (wl * 0.5)))),
        )
      }
      ink[y * W + x] = clamp01(onPrint + 0.5)
      paper[y * W + x] = clamp01(onPaper + 0.5)
    }
  const print = (x: number, y: number) => o.print(x - m + 0.5, y - m + 0.5)
  return { canvas: finish(io, W, H, ink, paper, print, o, scale, true), margin: m }
}
