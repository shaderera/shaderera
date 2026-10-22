glTF 2.0 models read into plain data: each primitive's positions, normals, uvs and indices as typed arrays, its node's world matrix, and its material as the file states it.

```ts
import { loadGltf } from './render/gltf.ts'

// in open
const model = await loadGltf(host, 'assets/chair.glb')     // or 'assets/chair.gltf' with its .bin
for (const p of model.primitives) {
  // p.positions, p.normals?, p.uvs?: Float32Array; p.indices: Uint32Array, three a triangle
  // p.matrix: the node's world matrix, column-major; p.material: { baseColor, alphaMode, textures }
  // p.material.textures.baseColor: { path } for io.image, or { bytes, mimeType } when embedded
}
model.unread                       // what the file has and this leaves out, for inspect()
```

It reads only. Units, centring, scale, texture decoding and materials are the film's: draw the
arrays with WebGPU, three.js (`render-three-host`) or anything else, and decode textures with
`io.image` (`path`, relative to the project root), or decode `bytes` (an image inside a GLB or a
data: URI) with fast-png or jpeg-js. No packages.

- One entry per node that draws a mesh, in scene order: a mesh two nodes use comes twice, with
  each node's matrix. The scene is the file's `scene`, else its first; a file with no scenes gives
  every node no other node holds.
- Positions stay in the primitive's own space; `matrix` is the parents' transforms times the
  node's own (its `matrix`, or translation × rotation × scale).
- Accessors are read as glTF stores them: interleaved or packed, sparse, any component type.
  Normalised integers (quantised uvs, KHR_mesh_quantization) come back as 0–1 or −1–1 floats;
  indices of any width as `Uint32Array`, and 0, 1, 2… for a primitive with none.
- Material: the base colour factor (linear), `alphaMode` and `alphaCutoff`, `doubleSided`, and the
  base colour, metallic-roughness, normal, occlusion and emissive textures with their uv set. A
  primitive with no material gets glTF's default (white, opaque).
- Refused by name, never read as wrong geometry: any required extension but KHR_mesh_quantization
  (KHR_draco_mesh_compression, EXT_meshopt_compression, KHR_texture_basisu…), primitives that are
  not TRIANGLES (`LINES`, `TRIANGLE_STRIP`…), glTF 1.0, and buffers or accessors that run short.
- Not read, and listed in `unread`: skins and morph targets (a mesh comes in its rest pose),
  animations, and extensions the file uses without requiring them. Cameras, lights, samplers,
  uv sets past the first and vertex colours are ignored.
