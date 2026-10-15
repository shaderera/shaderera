// render-gltf-read, headless: one small model made here, written as a .gltf with its .bin and as a
// .glb, both read through a fake host into the same data. Checked: interleaved, quantised and
// sparse accessors, a mesh two nodes draw, world matrices from TRS and from a matrix, the material
// as stated, embedded images, and refusals by name.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadGltf, readGltf } from '../render-gltf-read/src/render/gltf.ts'

type Json = Record<string, unknown>

/** Byte chunks laid end to end, each on a 4-byte boundary, and the buffer views over them. */
const pack = (chunks: { bytes: Uint8Array; stride?: number }[]) => {
  const views: Json[] = []
  let length = 0
  for (const c of chunks) {
    views.push({
      buffer: 0,
      byteOffset: length,
      byteLength: c.bytes.length,
      ...(c.stride ? { byteStride: c.stride } : {}),
    })
    length += Math.ceil(c.bytes.length / 4) * 4
  }
  const bin = new Uint8Array(length)
  for (const [i, c] of chunks.entries()) bin.set(c.bytes, views[i]?.byteOffset as number)
  return { bin, views }
}
const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)

/** A tetrahedron's corners, each with a normal beside it (24 bytes a vertex), u8 uvs, u16 indices. */
const CORNERS = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]
const interleaved = new Float32Array(24)
for (let v = 0; v < 4; v++) {
  interleaved.set(CORNERS.slice(v * 3, v * 3 + 3), v * 6)
  interleaved.set([0, 0, 1], v * 6 + 3)
}
const UVS = [0, 0, 255, 0, 0, 255, 255, 255]
const TETRA = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]
/** One loose triangle, unindexed, its middle corner moved by a sparse accessor. */
const TRIANGLE = [0, 0, 0, 1, 0, 0, 0, 1, 0]
const { bin, views } = pack([
  { bytes: bytesOf(interleaved), stride: 24 },
  { bytes: new Uint8Array(UVS) },
  { bytes: bytesOf(new Uint16Array(TETRA)) },
  { bytes: bytesOf(new Float32Array(TRIANGLE)) },
  { bytes: new Uint8Array([1]) },
  { bytes: bytesOf(new Float32Array([2, 2, 0])) },
])

const s = Math.SQRT1_2
const model = (buffer: Json) => ({
  asset: { version: '2.0', generator: 'render-gltf-read test' },
  scene: 0,
  scenes: [{ nodes: [0, 3] }, { nodes: [3] }],
  nodes: [
    // A quarter turn about y, doubled, moved: its children inherit it.
    {
      name: 'group',
      translation: [1, 2, 3],
      rotation: [0, s, 0, s],
      scale: [2, 2, 2],
      children: [1, 2],
    },
    { name: 'near', mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1] },
    { mesh: 0 },
    { name: 'loose', mesh: 1 },
  ],
  meshes: [
    {
      name: 'tetra',
      primitives: [
        { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 },
      ],
    },
    { primitives: [{ attributes: { POSITION: 4 } }] },
  ],
  materials: [
    {
      name: 'grain',
      pbrMetallicRoughness: {
        baseColorFactor: [0.5, 0.25, 1, 0.8],
        baseColorTexture: { index: 0 },
      },
      alphaMode: 'MASK',
      alphaCutoff: 0.3,
      doubleSided: true,
    },
  ],
  textures: [{ source: 0 }],
  images: [{ uri: 'textures/wood%20grain.png' }],
  accessors: [
    { bufferView: 0, byteOffset: 0, componentType: 5126, count: 4, type: 'VEC3' },
    { bufferView: 0, byteOffset: 12, componentType: 5126, count: 4, type: 'VEC3' },
    { bufferView: 1, componentType: 5121, normalized: true, count: 4, type: 'VEC2' },
    { bufferView: 2, componentType: 5123, count: 12, type: 'SCALAR' },
    {
      bufferView: 3,
      componentType: 5126,
      count: 3,
      type: 'VEC3',
      sparse: {
        count: 1,
        indices: { bufferView: 4, componentType: 5121 },
        values: { bufferView: 5 },
      },
    },
  ],
  bufferViews: views,
  buffers: [{ byteLength: bin.length, ...buffer }],
})

const glbOf = (json: Json, binary?: Uint8Array) => {
  const text = new TextEncoder().encode(JSON.stringify(json))
  const jsonChunk = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20)
  jsonChunk.set(text)
  const chunks: [number, Uint8Array][] = [[0x4e4f534a, jsonChunk]]
  if (binary) chunks.push([0x004e4942, binary])
  const total = 12 + chunks.reduce((n, [, c]) => n + 8 + c.length, 0)
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x46546c67, true)
  v.setUint32(4, 2, true)
  v.setUint32(8, total, true)
  let o = 12
  for (const [type, c] of chunks) {
    v.setUint32(o, c.length, true)
    v.setUint32(o + 4, type, true)
    out.set(c, o + 8)
    o += 8 + c.length
  }
  return out
}

const files = new Map<string, Uint8Array>([
  ['models/tetra.gltf', new TextEncoder().encode(JSON.stringify(model({ uri: 'tetra.bin' })))],
  ['models/tetra.bin', bin],
  ['models/tetra.glb', glbOf(model({}), bin)],
])
const read = async (path: string) => {
  const bytes = files.get(path)
  if (!bytes) throw new Error(`No file ${path}`)
  return bytes
}
const host = { io: { read } }
const close = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  assert.ok(
    a.length === b.length && Array.from(a).every((x, i) => Math.abs(x - (b[i] ?? 0)) < 1e-6),
    `${Array.from(a)} is not ${Array.from(b)}`,
  )

test('render-gltf-read: a .gltf with its .bin and a .glb of the same model read the same', async () => {
  const gltf = await loadGltf(host, 'models/tetra.gltf')
  const glb = await loadGltf(host, 'models/tetra.glb')
  assert.deepEqual(glb, gltf)
  assert.deepEqual(
    gltf.primitives.map((p) => [p.name, p.node, p.mesh, p.primitive, p.count]),
    [
      ['near', 1, 0, 0, 4],
      ['tetra', 2, 0, 0, 4],
      ['loose', 3, 1, 0, 3],
    ],
  )
  const [near, inGroup, loose] = gltf.primitives
  assert.ok(near && inGroup && loose)
  // Interleaved positions and normals, quantised uvs, u16 indices widened.
  close(near.positions, CORNERS)
  close(near.normals ?? [], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])
  close(near.uvs ?? [], [0, 0, 1, 0, 0, 1, 1, 1])
  assert.ok(near.indices instanceof Uint32Array)
  assert.deepEqual([...near.indices], TETRA)
  // The same arrays for the mesh's second node; only the matrix differs.
  assert.deepEqual(inGroup.positions, near.positions)
  // Unindexed: 0, 1, 2; the sparse value replaces the middle corner; no normals or uvs.
  assert.deepEqual([...loose.indices], [0, 1, 2])
  close(loose.positions, [0, 0, 0, 2, 2, 0, 0, 1, 0])
  assert.equal(loose.normals, undefined)
  assert.equal(loose.uvs, undefined)
  assert.deepEqual(gltf.unread, [])
})

test('render-gltf-read: world matrices from TRS and matrices, positions in their own space', async () => {
  const { primitives } = await loadGltf(host, 'models/tetra.glb')
  const [near, inGroup, loose] = primitives
  assert.ok(near && inGroup && loose)
  const apply = (m: readonly number[], [x, y, z]: number[]) =>
    [0, 1, 2].map(
      (r) =>
        (m[r] ?? 0) * (x ?? 0) +
        (m[4 + r] ?? 0) * (y ?? 0) +
        (m[8 + r] ?? 0) * (z ?? 0) +
        (m[12 + r] ?? 0),
    )
  // group: scale 2, a quarter turn about y (+z goes to +x), then +[1, 2, 3].
  close(apply(inGroup.matrix, [0, 0, 1]), [3, 2, 3])
  close(apply(inGroup.matrix, [1, 0, 0]), [1, 2, 1])
  // near: its own +5 on z first, inside the group.
  close(apply(near.matrix, [0, 0, 0]), [11, 2, 3])
  close(loose.matrix, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
})

test('render-gltf-read: the material as the file states it, images by path or by bytes', async () => {
  const { primitives } = await loadGltf(host, 'models/tetra.gltf')
  assert.deepEqual(primitives[0]?.material, {
    name: 'grain',
    baseColor: [0.5, 0.25, 1, 0.8],
    alphaMode: 'MASK',
    alphaCutoff: 0.3,
    doubleSided: true,
    textures: { baseColor: { path: 'models/textures/wood grain.png', texCoord: 0 } },
  })
  assert.deepEqual(primitives[2]?.material, {
    baseColor: [1, 1, 1, 1],
    alphaMode: 'OPAQUE',
    alphaCutoff: 0.5,
    doubleSided: false,
    textures: {},
  })

  // A GLB's image in a buffer view, and a .gltf's buffer and image as data: URIs.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  const inside = model({})
  inside.images = [{ bufferView: 6, mimeType: 'image/png' }]
  const embedded = new Uint8Array(bin.length + png.length)
  embedded.set(bin)
  embedded.set(png, bin.length)
  inside.bufferViews = [...views, { buffer: 0, byteOffset: bin.length, byteLength: png.length }]
  inside.buffers = [{ byteLength: embedded.length }]
  files.set('in.glb', glbOf(inside, embedded))
  const fromGlb = (await readGltf(read, 'in.glb')).primitives[0]?.material.textures.baseColor
  assert.deepEqual(fromGlb, { bytes: png, mimeType: 'image/png', texCoord: 0 })

  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
  const uris = model({ uri: `data:application/octet-stream;base64,${b64(bin)}` })
  uris.images = [{ uri: `data:image/png;base64,${b64(png)}` }]
  files.set('uris.gltf', new TextEncoder().encode(JSON.stringify(uris)))
  const fromUris = await readGltf(read, 'uris.gltf')
  assert.deepEqual(fromUris.primitives[0]?.material.textures.baseColor, {
    bytes: png,
    mimeType: 'image/png',
    texCoord: 0,
  })
  assert.deepEqual(
    fromUris.primitives[0]?.positions,
    (await readGltf(read, 'models/tetra.gltf')).primitives[0]?.positions,
  )
})

test('render-gltf-read: refuses what it cannot read by name, lists what it leaves out', async () => {
  const variant = async (change: (m: ReturnType<typeof model>) => void, binary = bin) => {
    const m = model({})
    change(m)
    files.set('v.glb', glbOf(m, binary))
    return readGltf(read, 'v.glb')
  }
  await assert.rejects(
    variant((m) => Object.assign(m, { extensionsRequired: ['KHR_draco_mesh_compression'] })),
    /v\.glb requires KHR_draco_mesh_compression, which this reader does not read/,
  )
  await assert.rejects(
    variant((m) =>
      Object.assign(m, {
        extensionsRequired: ['KHR_mesh_quantization', 'EXT_meshopt_compression'],
      }),
    ),
    /requires EXT_meshopt_compression,/,
  )
  await assert.rejects(
    variant((m) => {
      ;(m.meshes[1]?.primitives[0] as Json).mode = 5
    }),
    /mesh 1 primitive 0 is TRIANGLE_STRIP; only TRIANGLES are read/,
  )
  await assert.rejects(
    variant((m) => {
      m.asset.version = '1.0'
    }),
    /is glTF 1\.0; only 2\.0 is read/,
  )
  await assert.rejects(
    variant(() => {}, bin.subarray(0, 40)),
    /buffer 0 has 40 bytes, not/,
  )
  await assert.rejects(
    variant((m) => {
      ;(m.accessors[3] as Json).count = 40
    }),
    /accessor 3 runs past its buffer view/,
  )
  await assert.rejects(readGltf(read, 'models/missing.gltf'), /No file models\/missing\.gltf/)

  // Quantised positions under KHR_mesh_quantization are read; skins and animations are listed.
  const quantised = await variant((m) => {
    Object.assign(m, {
      extensionsRequired: ['KHR_mesh_quantization'],
      extensionsUsed: ['KHR_mesh_quantization', 'KHR_materials_clearcoat'],
      animations: [{ channels: [], samplers: [] }],
    })
    m.accessors[0] = { bufferView: 1, componentType: 5121, count: 2, type: 'VEC3' }
    ;(m.nodes[2] as Json).skin = 0
  })
  close(quantised.primitives[0]?.positions ?? [], [0, 0, 255, 0, 0, 255])
  assert.deepEqual(quantised.unread, [
    'extension KHR_materials_clearcoat',
    'animations',
    'skin on node 2',
  ])
})
