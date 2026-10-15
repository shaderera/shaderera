// The preview's model, made in code as a GLB's bytes: a unit cube (indexed, 24 corners with
// normals) and a square pyramid (unindexed). A plinth; a row of three cubes under one turned
// parent, the same mesh three times; a pyramid on the middle cube, placed by a matrix. Three grey
// materials, by base colour only.

type Json = Record<string, unknown>
type V3 = [number, number, number]

const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

/** Each face's outward normal and two edges along it, u × v = n, so its corners turn outward. */
const FACES: [V3, V3, V3][] = [
  [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  [
    [-1, 0, 0],
    [0, 0, 1],
    [0, 1, 0],
  ],
  [
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 0],
  ],
  [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ],
  [
    [0, 0, 1],
    [1, 0, 0],
    [0, 1, 0],
  ],
  [
    [0, 0, -1],
    [0, 1, 0],
    [1, 0, 0],
  ],
]

const cube = () => {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  for (const [f, [n, u, v]] of FACES.entries()) {
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      positions.push(...([0, 1, 2] as const).map((k) => (n[k] + a * u[k] + b * v[k]) / 2))
      normals.push(...n)
    }
    indices.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3)
  }
  return { positions, normals, indices }
}

/** A square pyramid on y = 0, apex at y = 1, one triangle after another. */
const pyramid = () => {
  const apex: V3 = [0, 1, 0]
  const base: V3[] = [
    [-0.5, 0, -0.5],
    [-0.5, 0, 0.5],
    [0.5, 0, 0.5],
    [0.5, 0, -0.5],
  ]
  const tris: [V3, V3, V3][] = base.map((a, i) => [a, base[(i + 1) % 4] as V3, apex])
  tris.push(
    [base[0] as V3, base[3] as V3, base[2] as V3],
    [base[0] as V3, base[2] as V3, base[1] as V3],
  )
  const positions: number[] = []
  const normals: number[] = []
  for (const [a, b, c] of tris) {
    const n = cross(
      [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
    )
    const l = Math.hypot(...n)
    for (const p of [a, b, c]) {
      positions.push(...p)
      normals.push(n[0] / l, n[1] / l, n[2] / l)
    }
  }
  return { positions, normals }
}

/** The model as GLB bytes, the way an exporter writes one. */
export const makeModel = () => {
  const c = cube()
  const p = pyramid()
  const parts = [
    new Float32Array(c.positions),
    new Float32Array(c.normals),
    new Uint16Array(c.indices),
    new Float32Array(p.positions),
    new Float32Array(p.normals),
  ]
  const views: Json[] = []
  let length = 0
  for (const a of parts) {
    views.push({ buffer: 0, byteOffset: length, byteLength: a.byteLength })
    length += Math.ceil(a.byteLength / 4) * 4
  }
  const bin = new Uint8Array(length)
  for (const [i, a] of parts.entries())
    bin.set(new Uint8Array(a.buffer), (views[i] as { byteOffset: number }).byteOffset)
  const turn = Math.sin(Math.PI / 12)
  const json = {
    asset: { version: '2.0', generator: 'render-gltf-read preview' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      { name: 'plinth', mesh: 2, translation: [0, -0.15, 0], scale: [3.2, 0.3, 1.6] },
      {
        name: 'row',
        rotation: [0, turn, 0, Math.cos(Math.PI / 12)],
        children: [2, 3, 4],
      },
      { name: 'left', mesh: 0, translation: [-1.05, 0.35, 0], scale: [0.7, 0.7, 0.7] },
      { name: 'middle', mesh: 0, translation: [0, 0.5, 0], children: [5] },
      { name: 'right', mesh: 0, translation: [1.05, 0.3, 0], scale: [0.6, 0.6, 0.6] },
      { name: 'cap', mesh: 1, matrix: [0.8, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0.8, 0, 0, 0.5, 0, 1] },
    ],
    meshes: [
      {
        name: 'cube',
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 1 }],
      },
      { name: 'pyramid', primitives: [{ attributes: { POSITION: 3, NORMAL: 4 }, material: 2 }] },
      {
        name: 'slab',
        primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }],
      },
    ],
    materials: [0.3, 0.62, 0.92].map((g, i) => ({
      name: ['plinth', 'block', 'cap'][i],
      pbrMetallicRoughness: { baseColorFactor: [g, g, g, 1] },
    })),
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 24,
        type: 'VEC3',
        min: [-0.5, -0.5, -0.5],
        max: [0.5, 0.5, 0.5],
      },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
      {
        bufferView: 3,
        componentType: 5126,
        count: 18,
        type: 'VEC3',
        min: [-0.5, 0, -0.5],
        max: [0.5, 1, 0.5],
      },
      { bufferView: 4, componentType: 5126, count: 18, type: 'VEC3' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  }
  const text = new TextEncoder().encode(JSON.stringify(json))
  const head = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20)
  head.set(text)
  const out = new Uint8Array(12 + 8 + head.length + 8 + bin.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x46546c67, true)
  v.setUint32(4, 2, true)
  v.setUint32(8, out.length, true)
  v.setUint32(12, head.length, true)
  v.setUint32(16, 0x4e4f534a, true)
  out.set(head, 20)
  v.setUint32(20 + head.length, bin.length, true)
  v.setUint32(24 + head.length, 0x004e4942, true)
  out.set(bin, 28 + head.length)
  return out
}
