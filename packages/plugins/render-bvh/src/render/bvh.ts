// A bounding volume hierarchy over triangles, for ray queries on the GPU: built here on the CPU
// with a binned SAH, from positions and indices as plain typed arrays, into the two arrays the
// closest-hit and any-hit functions in bvh.wgsl.ts read. It knows no materials, normals or
// shading: a hit is a distance, the triangle's index in the mesh as given, and its barycentrics.
// The same mesh gives the same bytes: no randomness, and ties keep the mesh's order.

export type BvhOptions = {
  /** SAH bins per axis: more finds slightly better splits and builds slower. */
  bins?: number
  /** The most triangles a leaf holds, unless they cannot be told apart (one centroid). */
  leaf?: number
}

export type Bvh = {
  /**
   * Two vec4 a node, 32 bytes, node 0 the root: min.xyz and `first`, then max.xyz and `count`,
   * `first` and `count` as u32 bits. A leaf has `count` triangles from `first`; an inner node has
   * `count` 0 and its children at `first` and `first + 1`.
   */
  nodes: Float32Array
  /**
   * Three vec4 a triangle, 48 bytes, in leaf order: v0.xyz and the triangle's index in the mesh
   * (`indices` / 3) as u32 bits, v1.xyz and 0, v2.xyz and 0. Never empty: a mesh with no
   * triangles gets one of zeros, which no node points to.
   */
  triangles: Float32Array
  nodeCount: number
  triangleCount: number
  /** Levels below the root: at most BVH_DEPTH − 1. */
  depth: number
}

/** The deepest a tree goes, and the size of the traversal's stack in bvh.wgsl.ts. */
export const BVH_DEPTH = 64

/** The tree over `indices.length / 3` triangles whose corners index `positions` (xyz a vertex). */
export const buildBvh = (
  positions: Float32Array,
  indices: Uint32Array | Uint16Array,
  o: BvhOptions = {},
): Bvh => {
  const bins = Math.max(2, Math.floor(o.bins ?? 12))
  const leaf = Math.max(1, Math.floor(o.leaf ?? 4))
  if (indices.length % 3)
    throw new Error(`render-bvh: ${indices.length} indices is not a whole number of triangles`)
  const n = indices.length / 3
  const vertices = Math.floor(positions.length / 3)

  // Each triangle's bounds and centroid.
  const lo = new Float32Array(n * 3)
  const hi = new Float32Array(n * 3)
  const mid = new Float32Array(n * 3)
  for (let t = 0; t < n; t++)
    for (let k = 0; k < 3; k++) {
      let a = Number.POSITIVE_INFINITY
      let b = Number.NEGATIVE_INFINITY
      for (let c = 0; c < 3; c++) {
        const v = indices[t * 3 + c] ?? 0
        if (v >= vertices)
          throw new Error(`render-bvh: triangle ${t} uses vertex ${v}; there are ${vertices}`)
        const p = positions[v * 3 + k] ?? 0
        a = Math.min(a, p)
        b = Math.max(b, p)
      }
      lo[t * 3 + k] = a
      hi[t * 3 + k] = b
      mid[t * 3 + k] = (a + b) / 2
    }

  const order = new Uint32Array(n).map((_, i) => i)
  const nodes = new Float32Array(Math.max(1, 2 * n - 1) * 8)
  const bits = new Uint32Array(nodes.buffer)
  let used = 1
  let depth = 0

  const box = new Float64Array(6)
  const empty = (b: Float64Array, at = 0) => {
    b.fill(Number.POSITIVE_INFINITY, at, at + 3)
    b.fill(Number.NEGATIVE_INFINITY, at + 3, at + 6)
  }
  const grow = (b: Float64Array, at: number, t: number) => {
    for (let k = 0; k < 3; k++) {
      b[at + k] = Math.min(b[at + k] ?? 0, lo[t * 3 + k] ?? 0)
      b[at + 3 + k] = Math.max(b[at + 3 + k] ?? 0, hi[t * 3 + k] ?? 0)
    }
  }
  const area = (b: Float64Array, at = 0) => {
    const x = (b[at + 3] ?? 0) - (b[at] ?? 0)
    const y = (b[at + 4] ?? 0) - (b[at + 1] ?? 0)
    const z = (b[at + 5] ?? 0) - (b[at + 2] ?? 0)
    return x * y + y * z + z * x
  }

  // The bins of one axis, and the sweep from the right.
  const binBox = new Float64Array(bins * 6)
  const blank = new Float64Array(bins * 6)
  for (let b = 0; b < bins; b++) empty(blank, b * 6)
  const binCount = new Uint32Array(bins)
  const rightArea = new Float64Array(bins)
  const rightCount = new Uint32Array(bins)
  const sweep = new Float64Array(6)
  const cmin = [0, 0, 0]
  const cmax = [0, 0, 0]
  const binOf = (t: number, axis: number, scale: number) =>
    Math.min(bins - 1, Math.floor(((mid[t * 3 + axis] ?? 0) - (cmin[axis] ?? 0)) * scale))

  const build = (node: number, first: number, count: number, level: number) => {
    depth = Math.max(depth, level)
    empty(box)
    cmin.fill(Number.POSITIVE_INFINITY)
    cmax.fill(Number.NEGATIVE_INFINITY)
    for (let i = first; i < first + count; i++) {
      const t = order[i] ?? 0
      grow(box, 0, t)
      for (let k = 0; k < 3; k++) {
        cmin[k] = Math.min(cmin[k] ?? 0, mid[t * 3 + k] ?? 0)
        cmax[k] = Math.max(cmax[k] ?? 0, mid[t * 3 + k] ?? 0)
      }
    }
    const at = node * 8
    if (count === 0) nodes.fill(0, at, at + 8)
    else {
      nodes.set([box[0] ?? 0, box[1] ?? 0, box[2] ?? 0], at)
      nodes.set([box[3] ?? 0, box[4] ?? 0, box[5] ?? 0], at + 4)
    }
    const parent = area(box)
    const asLeaf = () => {
      bits[at + 3] = first
      bits[at + 7] = count
    }
    if (count <= 1 || level >= BVH_DEPTH - 1) return asLeaf()

    // The cheapest plane between bins, on any axis: triangles times area on each side.
    let best = Number.POSITIVE_INFINITY
    let bestAxis = -1
    let bestPlane = 0
    for (let axis = 0; axis < 3; axis++) {
      const extent = (cmax[axis] ?? 0) - (cmin[axis] ?? 0)
      if (!(extent > 0)) continue
      const scale = bins / extent
      binCount.fill(0)
      binBox.set(blank)
      for (let i = first; i < first + count; i++) {
        const t = order[i] ?? 0
        const b = binOf(t, axis, scale)
        grow(binBox, b * 6, t)
        binCount[b] = (binCount[b] ?? 0) + 1
      }
      empty(sweep)
      let right = 0
      for (let b = bins - 1; b > 0; b--) {
        right += binCount[b] ?? 0
        if (binCount[b]) growBox(sweep, binBox, b * 6)
        rightCount[b] = right
        rightArea[b] = right ? area(sweep) : 0
      }
      empty(sweep)
      let left = 0
      for (let plane = 1; plane < bins; plane++) {
        left += binCount[plane - 1] ?? 0
        if (binCount[plane - 1]) growBox(sweep, binBox, (plane - 1) * 6)
        const r = rightCount[plane] ?? 0
        if (!left || !r) continue
        const cost = left * area(sweep) + r * (rightArea[plane] ?? 0)
        if (cost < best) {
          best = cost
          bestAxis = axis
          bestPlane = plane
        }
      }
    }

    let split = first
    if (bestAxis < 0) {
      // Every centroid in one place: no plane parts them, so halve them in the mesh's order.
      if (count <= leaf) return asLeaf()
      split = first + (count >> 1)
    } else {
      // A leaf costs a test a triangle; a split one traversal step and its sides' share.
      if (count <= leaf && (parent <= 0 || count <= 1 + best / parent)) return asLeaf()
      const scale = bins / ((cmax[bestAxis] ?? 0) - (cmin[bestAxis] ?? 0))
      let i = first
      let j = first + count - 1
      while (i <= j) {
        const t = order[i] ?? 0
        if (binOf(t, bestAxis, scale) < bestPlane) i++
        else {
          order[i] = order[j] ?? 0
          order[j--] = t
        }
      }
      split = i
    }
    const left = used
    used += 2
    bits[at + 3] = left
    bits[at + 7] = 0
    build(left, first, split - first, level + 1)
    build(left + 1, split, first + count - split, level + 1)
  }
  build(0, 0, n, 0)

  const triangles = new Float32Array(Math.max(1, n) * 12)
  const ids = new Uint32Array(triangles.buffer)
  for (let i = 0; i < n; i++) {
    const t = order[i] ?? 0
    for (let c = 0; c < 3; c++) {
      const v = indices[t * 3 + c] ?? 0
      triangles.set(positions.subarray(v * 3, v * 3 + 3), i * 12 + c * 4)
    }
    ids[i * 12 + 3] = t
  }
  return { nodes: nodes.slice(0, used * 8), triangles, nodeCount: used, triangleCount: n, depth }
}

/** `b` grown by the box at `from` in `boxes`. */
const growBox = (b: Float64Array, boxes: Float64Array, from: number) => {
  for (let k = 0; k < 3; k++) {
    b[k] = Math.min(b[k] ?? 0, boxes[from + k] ?? 0)
    b[3 + k] = Math.max(b[3 + k] ?? 0, boxes[from + 3 + k] ?? 0)
  }
}
