Ray queries against triangles on the GPU: a tree built from any mesh's positions and indices, and the WGSL closest-hit and any-hit functions that read it.

```ts
import { buildBvh } from './render/bvh.ts'
import { BVH_WGSL } from './render/bvh.wgsl.ts'

// in open, or whenever the mesh changes: positions xyz a vertex, indices three a triangle
const bvh = buildBvh(positions, indices)             // Float32Array, Uint32Array or Uint16Array
const storage = (data: Float32Array) => {
  const b = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(b, 0, data)
  return b
}
const nodes = storage(bvh.nodes)
const triangles = storage(bvh.triangles)

// your shader: the functions, then the two buffers under these names, at any group and binding
const code = /* wgsl */ `${BVH_WGSL}
@group(0) @binding(0) var<storage, read> bvhNodes: array<vec4f>;
@group(0) @binding(1) var<storage, read> bvhTriangles: array<vec4f>;
// …
let hit = bvhClosest(origin, dir, 1e-4, 1e30);        // BvhHit { t, triangle, u, v }
if (hit.triangle != BVH_MISS) {
  let p = origin + dir * hit.t;
  let lit = !bvhAny(p, toLight, 1e-4, lightDistance);  // a shadow ray
}
`
```

It does one job: where a ray meets the mesh. It does not shade, know materials, sample or trace
paths; those stay in the film's shader, which looks up its own normals, UVs and materials by
`hit.triangle`, the triangle's index in the mesh as given (`indices[3 * triangle + c]`), and
interpolates them with the barycentrics: the point is `(1 - u - v) v0 + u v1 + v v2`.

- `bvhClosest(origin, dir, tMin, tMax) -> BvhHit`: the nearest hit with `tMin < t < tMax`; `t`
  is in units of `dir`'s length, so normalise `dir` for distances. No hit: `triangle` is
  `BVH_MISS` and `t` is `tMax`.
- `bvhAny(origin, dir, tMin, tMax) -> bool`: whether anything lies between, stopping at the first
  triangle found: shadow and occlusion rays.
- Triangles are two-sided Möller–Trumbore. It is not watertight: a ray exactly through an edge two
  triangles share may, rarely, slip between them. Start secondary rays a little off the surface
  (`tMin`).
- `buildBvh(positions, indices, { bins: 12, leaf: 4 })` is a binned SAH on the CPU, O(n log n):
  build once for a still mesh, or again each frame for one that moves (about 0.1 s for 20 000
  triangles and 1 s for 200 000 on a desktop CPU). The same mesh gives the same bytes. It throws
  on an index past the last vertex.
- Traversal keeps a stack of `BVH_DEPTH` (64) nodes and visits the nearer child first; the builder
  makes no deeper tree. Everything is `f32`; keep the mesh within a few thousand units of the
  origin.
- Needs WebGPU compute or fragment shaders with storage buffers, up to the device's
  `maxStorageBufferBindingSize` (128 MiB by default: about 2.7M triangles).

## The layout

Both arrays are `Float32Array`s of `vec4`s, 16-byte aligned, uploaded as they are. The integer
fields are `u32` bits in an `f32` slot: `bitcast<u32>(…)` in WGSL, a `Uint32Array` over the same
buffer in JS.

`bvh.nodes`, `bvh.nodeCount` nodes of 32 bytes; node 0 is the root:

| vec4 | x | y | z | w |
|---|---|---|---|---|
| `2i` | min x | min y | min z | `first` (u32) |
| `2i + 1` | max x | max y | max z | `count` (u32) |

A leaf has `count` > 0 triangles, `first` to `first + count - 1` in `bvh.triangles`. An inner node
has `count` 0 and its two children at nodes `first` and `first + 1`. A mesh with no triangles is
one empty leaf.

`bvh.triangles`, `bvh.triangleCount` triangles of 48 bytes, in leaf order:

| vec4 | x | y | z | w |
|---|---|---|---|---|
| `3j` | v0 x | v0 y | v0 z | the triangle's index in the mesh (u32) |
| `3j + 1` | v1 x | v1 y | v1 z | 0 |
| `3j + 2` | v2 x | v2 y | v2 z | 0 |

The corners keep the mesh's winding. With no triangles the array still holds one of zeros, since
a storage buffer cannot be empty.
