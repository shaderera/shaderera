// The preview's glTF file, made in code as its JSON text with the buffer as a data: URI: one
// 6 s clip on three nodes, one for each interpolation. `step` moves by STEP; `linear` moves and
// turns by LINEAR (the turn slerped); `cubic` moves and turns by CUBICSPLINE with in and out
// tangents. A skin and a mesh with two morph targets are there so the reader reports them.

const q = (deg: number) => [0, 0, Math.sin((deg * Math.PI) / 360), Math.cos((deg * Math.PI) / 360)]

export const makeClips = () => {
  const chunks: number[][] = []
  const accessors: Record<string, unknown>[] = []
  const views: Record<string, unknown>[] = []
  let offset = 0
  const add = (values: number[], type: 'SCALAR' | 'VEC3' | 'VEC4') => {
    const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type]
    views.push({ buffer: 0, byteOffset: offset, byteLength: values.length * 4 })
    accessors.push({
      bufferView: views.length - 1,
      componentType: 5126,
      count: values.length / width,
      type,
    })
    chunks.push(values)
    offset += values.length * 4
    return accessors.length - 1
  }
  const stepT = add([0, 1.5, 3, 4.5], 'SCALAR')
  const linT = add([0, 2, 3.5, 6], 'SCALAR')
  const cubT = add([0, 2.5, 6], 'SCALAR')
  const stepP = add([-3.5, -1, 0, -2.5, 0.4, 0, -1.5, -0.6, 0, -3, 1.2, 0], 'VEC3')
  const linP = add([-1, -1.4, 0, 1, 1.2, 0, 1.4, -0.8, 0, -1, -1.4, 0], 'VEC3')
  const linR = add([...q(0), ...q(150), ...q(-60), ...q(0)], 'VEC4')
  // Three a key: in-tangent, value, out-tangent.
  const cubP = add(
    [
      ...[0, 0, 0, 2.2, -1.2, 0, 0, 0.5, 0],
      ...[2, 0, 0, 3.4, 1.2, 0, 1.5, -0.6, 0],
      ...[-0.5, 0.5, 0, 2.2, -1.2, 0, 0, 0, 0],
    ],
    'VEC3',
  )
  const cubR = add(
    [
      ...[0, 0, 0, 0, ...q(0), 0, 0, 0.6, 0],
      ...[0, 0, -0.4, 0, ...q(120), 0, 0, 0.3, 0],
      ...[0, 0, 0, 0, ...q(0), 0, 0, 0, 0],
    ],
    'VEC4',
  )
  const morph = add([0, 0, 0, 0, 0, 0, 0, 0, 0], 'VEC3')
  const bytes = new Uint8Array(new Float32Array(chunks.flat()).buffer)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return JSON.stringify({
    asset: { version: '2.0', generator: 'motion-gltf-clips preview' },
    buffers: [
      { uri: `data:application/octet-stream;base64,${btoa(binary)}`, byteLength: bytes.length },
    ],
    bufferViews: views,
    accessors,
    nodes: [
      { name: 'step' },
      { name: 'linear' },
      { name: 'cubic', skin: 0 },
      { name: 'face', mesh: 0 },
    ],
    skins: [{ name: 'rig', joints: [0, 1, 2] }],
    meshes: [
      {
        name: 'face',
        primitives: [
          { attributes: { POSITION: morph }, targets: [{ POSITION: morph }, { POSITION: morph }] },
        ],
      },
    ],
    animations: [
      {
        name: 'clip',
        samplers: [
          { input: stepT, output: stepP, interpolation: 'STEP' },
          { input: linT, output: linP, interpolation: 'LINEAR' },
          { input: linT, output: linR, interpolation: 'LINEAR' },
          { input: cubT, output: cubP, interpolation: 'CUBICSPLINE' },
          { input: cubT, output: cubR, interpolation: 'CUBICSPLINE' },
        ],
        channels: [
          { sampler: 0, target: { node: 0, path: 'translation' } },
          { sampler: 1, target: { node: 1, path: 'translation' } },
          { sampler: 2, target: { node: 1, path: 'rotation' } },
          { sampler: 3, target: { node: 2, path: 'translation' } },
          { sampler: 4, target: { node: 2, path: 'rotation' } },
        ],
      },
    ],
  })
}
