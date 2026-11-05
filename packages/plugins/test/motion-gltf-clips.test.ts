// motion-gltf-clips: copied into a project the way `add` lays it out, with the render-gltf-read it
// requires. One small glTF made here (MIT), its buffer a data: URI: every channel comes back
// exactly as the accessors hold it, and `valueAt` matches the glTF 2.0 spec's formulas (STEP,
// LINEAR with slerp for rotation, CUBICSPLINE Hermite), written out again here, within 1e-6.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'motion-gltf-clips')
rmSync(project, { recursive: true, force: true })
for (const item of ['motion-gltf-clips', 'render-gltf-read']) {
  const label = JSON.parse(readFileSync(join(plugins, item, 'shaderera.item.json'), 'utf8')) as {
    files: string[]
  }
  for (const f of label.files) {
    mkdirSync(dirname(join(project, f)), { recursive: true })
    cpSync(join(plugins, item, f), join(project, f))
  }
}
const C = (await import(
  pathToFileURL(join(project, 'src/motion/gltf-clips.ts')).href
)) as typeof import('../motion-gltf-clips/src/motion/gltf-clips.ts')
const G = (await import(
  pathToFileURL(join(project, 'src/render/gltf.ts')).href
)) as typeof import('../render-gltf-read/src/render/gltf.ts')

type Json = Record<string, unknown>

/** Accessors laid end to end in one buffer, each on a 4-byte boundary. */
const builder = () => {
  const chunks: Uint8Array[] = []
  const views: Json[] = []
  const accessors: Json[] = []
  let length = 0
  const add = (values: number[], type: string, componentType = 5126, normalized = false) => {
    const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type] as number
    const typed = componentType === 5122 ? new Int16Array(values) : new Float32Array(values)
    const bytes = new Uint8Array(typed.buffer)
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length })
    chunks.push(bytes)
    length += Math.ceil(bytes.length / 4) * 4
    accessors.push({
      bufferView: views.length - 1,
      componentType,
      count: values.length / width,
      type,
      ...(normalized ? { normalized } : {}),
    })
    return accessors.length - 1
  }
  const buffer = () => {
    const bin = new Uint8Array(length)
    let o = 0
    for (const c of chunks) {
      bin.set(c, o)
      o += Math.ceil(c.length / 4) * 4
    }
    return {
      uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString('base64')}`,
      byteLength: length,
    }
  }
  return { add, views, accessors, buffer }
}

const n = (q: number[]) => {
  const l = Math.hypot(...q)
  return q.map((x) => x / l)
}
// Key values as the file holds them: float32 values, and one rotation as normalised int16s.
const LIN_T = [0, 1, 2.5]
const LIN_P = [0, 0, 0, 2, -1, 0.5, 3, 4, -2]
// The second pair's dot is negative: the spec turns the short way round.
const LIN_R = [...n([0, 0, 0, 1]), ...n([0, 0.6, 0, 0.8]), ...n([0.3, -0.5, 0.1, -0.8])]
const SHORT_R = [0, 0, 0, 32767, 0, 23170, 0, 23170, -16384, 0, 0, 28378]
const LIN_W = [0, 1, 0.25, 0.5, 1, 0]
const STEP_T = [0.5, 1.5, 2]
const STEP_P = [1, 2, 3, 4, 5, 6, 7, 8, 9]
const CUB_T = [0, 0.75, 2]
// Three a key: in-tangent, value, out-tangent.
const CUB_P = [
  ...[9, 9, 9, 0, 0, 0, 1, -2, 0.5],
  ...[3, 1, -1, 2, 1, 0, -1, 0.5, 4],
  ...[0.5, 0.25, -3, 1, 3, 2, 7, 7, 7],
]
const CUB_R = [
  ...[0, 0, 0, 0, ...n([0, 0, 0, 1]), 0.2, 0, 0.4, 0],
  ...[0.1, -0.3, 0, 0.2, ...n([0.2, 0.4, 0.1, 0.9]), -0.5, 0.2, 0.1, 0],
  ...[0, 0.6, 0, -0.1, ...n([0, 0.8, 0, 0.6]), 0, 0, 0, 0],
]
const CUB_W = [...[0, 0, 0, 1, 2, -1], ...[1, 0.5, 1, 0, 0, 0], ...[-1, 1, 0.5, 0.5, 9, 9]]

const fixture = () => {
  const b = builder()
  const linT = b.add(LIN_T, 'SCALAR')
  const stepT = b.add(STEP_T, 'SCALAR')
  const cubT = b.add(CUB_T, 'SCALAR')
  const target = b.add([0, 0, 0, 0, 0, 0, 0, 0, 0], 'VEC3')
  const samplers = (list: [number, number, string | undefined][]) =>
    list.map(([input, output, interpolation]) => ({
      input,
      output,
      ...(interpolation ? { interpolation } : {}),
    }))
  const linear = samplers([
    [linT, b.add(LIN_P, 'VEC3'), undefined],
    [linT, b.add(LIN_R, 'VEC4'), 'LINEAR'],
    [linT, b.add(SHORT_R, 'VEC4', 5122, true), 'LINEAR'],
    [linT, b.add(LIN_W, 'SCALAR'), 'LINEAR'],
  ])
  const step = samplers([
    [stepT, b.add(STEP_P, 'VEC3'), 'STEP'],
    [stepT, b.add(LIN_R, 'VEC4'), 'STEP'],
  ])
  const cubic = samplers([
    [cubT, b.add(CUB_P, 'VEC3'), 'CUBICSPLINE'],
    [cubT, b.add(CUB_R, 'VEC4'), 'CUBICSPLINE'],
    [cubT, b.add(CUB_W, 'SCALAR'), 'CUBICSPLINE'],
  ])
  return {
    asset: { version: '2.0', generator: 'motion-gltf-clips test' },
    buffers: [b.buffer()],
    bufferViews: b.views,
    accessors: b.accessors,
    nodes: [
      { name: 'arm', children: [1] },
      { name: 'hand', skin: 0 },
      { mesh: 0, weights: [0, 0] },
    ],
    skins: [{ name: 'rig', joints: [0, 1] }],
    meshes: [
      {
        name: 'face',
        primitives: [
          {
            attributes: { POSITION: target },
            targets: [{ POSITION: target }, { POSITION: target }],
          },
        ],
      },
    ],
    animations: [
      {
        name: 'linear',
        samplers: linear,
        channels: [
          { sampler: 0, target: { node: 0, path: 'translation' } },
          { sampler: 1, target: { node: 0, path: 'rotation' } },
          { sampler: 2, target: { node: 1, path: 'rotation' } },
          { sampler: 3, target: { node: 2, path: 'weights' } },
        ],
      },
      {
        samplers: step,
        channels: [
          { sampler: 0, target: { node: 1, path: 'scale' } },
          { sampler: 1, target: { node: 1, path: 'rotation' } },
        ],
      },
      {
        name: 'cubic',
        samplers: cubic,
        channels: [
          { sampler: 0, target: { node: 0, path: 'translation' } },
          { sampler: 1, target: { node: 0, path: 'rotation' } },
          { sampler: 2, target: { node: 2, path: 'weights' } },
          // A channel an extension targets (KHR_animation_pointer): listed, not read.
          { sampler: 0, target: { path: 'pointer' } },
        ],
      },
    ],
  }
}

const open = (doc: Json) => {
  const bytes = new TextEncoder().encode(JSON.stringify(doc))
  return G.openGltf(async (p) => {
    if (p !== 'assets/rig.gltf') throw new Error(`No file ${p}`)
    return bytes
  }, 'assets/rig.gltf')
}

// The spec's formulas, written out again from glTF 2.0's "Interpolation" appendix.
const f32 = (v: number[]) => Array.from(Float32Array.from(v))
const keyOf = (values: number[], width: number, k: number, cubic = false, p = 1) =>
  values.slice((cubic ? k * 3 + p : k) * width, (cubic ? k * 3 + p : k) * width + width)
const segment = (times: number[], t: number) => {
  let k = 0
  while (k < times.length - 2 && (times[k + 1] as number) <= t) k++
  return k
}
const lerp = (a: number[], b: number[], u: number) =>
  a.map((x, i) => (1 - u) * x + u * (b[i] as number))
const slerp = (a: number[], b: number[], u: number) => {
  const dot = a.reduce((s, x, i) => s + x * (b[i] as number), 0)
  const angle = Math.acos(Math.abs(dot))
  const s = Math.sign(dot)
  return a.map(
    (x, i) =>
      (Math.sin(angle * (1 - u)) / Math.sin(angle)) * x +
      s * (Math.sin(angle * u) / Math.sin(angle)) * (b[i] as number),
  )
}
const spec = (
  times: number[],
  values: number[],
  width: number,
  mode: 'STEP' | 'LINEAR' | 'CUBICSPLINE',
  t: number,
  rotation = false,
) => {
  const T = f32(times)
  const V = values
  const cubic = mode === 'CUBICSPLINE'
  const last = T.length - 1
  if (t <= (T[0] as number)) return keyOf(V, width, 0, cubic)
  if (t >= (T[last] as number)) return keyOf(V, width, last, cubic)
  const k = segment(T, t)
  const tk = T[k] as number
  const td = (T[k + 1] as number) - tk
  const u = (t - tk) / td
  if (mode === 'STEP') return keyOf(V, width, k)
  if (mode === 'LINEAR') {
    const [a, b] = [keyOf(V, width, k), keyOf(V, width, k + 1)]
    return rotation ? slerp(a, b, u) : lerp(a, b, u)
  }
  const vk = keyOf(V, width, k, true, 1)
  const bk = keyOf(V, width, k, true, 2)
  const vk1 = keyOf(V, width, k + 1, true, 1)
  const ak1 = keyOf(V, width, k + 1, true, 0)
  const p = vk.map(
    (_, i) =>
      (2 * u ** 3 - 3 * u ** 2 + 1) * (vk[i] as number) +
      td * (u ** 3 - 2 * u ** 2 + u) * (bk[i] as number) +
      (-2 * u ** 3 + 3 * u ** 2) * (vk1[i] as number) +
      td * (u ** 3 - u ** 2) * (ak1[i] as number),
  )
  return rotation ? n(p) : p
}
const near = (got: number[], want: number[], what: string) => {
  assert.equal(got.length, want.length, `${what}: ${got.length} values`)
  for (const [i, w] of want.entries())
    assert.ok(Math.abs((got[i] as number) - w) <= 1e-6, `${what}[${i}]: ${got[i]} is not ${w}`)
}
/** Times across every segment, before the first key and after the last, and on each key. */
const sweep = (times: number[]) => {
  const out = [-1, ...times, (times.at(-1) as number) + 1]
  const a = times[0] as number
  const z = times.at(-1) as number
  for (let i = 0; i <= 200; i++) out.push(a + ((z - a) * i) / 200)
  return out
}

test('motion-gltf-clips: clips and channels come back as the accessors hold them', async () => {
  const gltf = await open(fixture())
  const { clips, skins, morphTargets, unread } = C.readClips(gltf)
  assert.deepEqual(
    clips.map((c) => [c.index, c.name, c.start, c.end, c.channels.length]),
    [
      [0, 'linear', 0, 2.5, 4],
      [1, undefined, 0.5, 2, 2],
      [2, 'cubic', 0, 2, 3],
    ],
  )
  const [lin, , cub] = clips
  assert.deepEqual(
    lin?.channels.map((c) => [c.node, c.nodeName, c.path, c.interpolation, c.sampler, c.width]),
    [
      [0, 'arm', 'translation', 'LINEAR', 0, 3],
      [0, 'arm', 'rotation', 'LINEAR', 1, 4],
      [1, 'hand', 'rotation', 'LINEAR', 2, 4],
      [2, undefined, 'weights', 'LINEAR', 3, 2],
    ],
  )
  const [p, r, short, w] = lin?.channels ?? []
  assert.deepEqual(Array.from(p?.input ?? []), f32(LIN_T))
  assert.deepEqual(Array.from(p?.output ?? []), f32(LIN_P))
  assert.deepEqual(Array.from(r?.output ?? []), f32(LIN_R))
  assert.deepEqual(
    Array.from(short?.output ?? []),
    f32(SHORT_R.map((c) => Math.max(c / 32767, -1))),
  )
  assert.deepEqual(Array.from(w?.output ?? []), f32(LIN_W))
  assert.deepEqual(Array.from(cub?.channels[0]?.output ?? []), f32(CUB_P))
  assert.equal(cub?.channels[0]?.output.length, CUB_T.length * 3 * 3)
  assert.deepEqual(skins, [{ index: 0, name: 'rig', joints: 2 }])
  assert.deepEqual(morphTargets, [{ mesh: 0, name: 'face', targets: 2 }])
  assert.deepEqual(unread, ['animations[2].channels[3]: path pointer, no node'])
  // The accessor reader is render-gltf-read's, exported from there.
  assert.deepEqual(Array.from(gltf.accessor(0)), f32(LIN_T))
})

test('motion-gltf-clips: STEP holds each key, and the first and last outside the keys', async () => {
  const [scale, rot] = C.readClips(await open(fixture())).clips[1]?.channels ?? []
  for (const t of sweep(STEP_T)) {
    near(C.valueAt(scale as never, t), spec(STEP_T, f32(STEP_P), 3, 'STEP', t), `scale at ${t}`)
    near(C.valueAt(rot as never, t), spec(STEP_T, f32(LIN_R), 4, 'STEP', t), `rotation at ${t}`)
  }
  near(C.valueAt(scale as never, 1.49), [1, 2, 3], 'held until the next key')
  near(C.valueAt(scale as never, 1.5), [4, 5, 6], 'the next key')
})

test('motion-gltf-clips: LINEAR lerps, and slerps rotation the short way', async () => {
  const [p, r, short, w] = C.readClips(await open(fixture())).clips[0]?.channels ?? []
  const shortValues = f32(SHORT_R.map((c) => Math.max(c / 32767, -1)))
  for (const t of sweep(LIN_T)) {
    near(C.valueAt(p as never, t), spec(LIN_T, f32(LIN_P), 3, 'LINEAR', t), `translation at ${t}`)
    near(
      C.valueAt(r as never, t),
      spec(LIN_T, f32(LIN_R), 4, 'LINEAR', t, true),
      `rotation at ${t}`,
    )
    near(
      C.valueAt(short as never, t),
      spec(LIN_T, shortValues, 4, 'LINEAR', t, true),
      `int16 rotation at ${t}`,
    )
    near(C.valueAt(w as never, t), spec(LIN_T, f32(LIN_W), 2, 'LINEAR', t), `weights at ${t}`)
  }
  // Halfway along the second pair, whose dot is negative: still unit length.
  const mid = C.valueAt(r as never, 1.75)
  assert.ok(Math.abs(Math.hypot(...mid) - 1) <= 1e-6)
  near(C.valueAt(p as never, 0.5), [1, -0.5, 0.25], 'translation halfway')
})

test('motion-gltf-clips: CUBICSPLINE is the Hermite spline with the file tangents', async () => {
  const [p, r, w] = C.readClips(await open(fixture())).clips[2]?.channels ?? []
  for (const t of sweep(CUB_T)) {
    near(
      C.valueAt(p as never, t),
      spec(CUB_T, f32(CUB_P), 3, 'CUBICSPLINE', t),
      `translation at ${t}`,
    )
    near(
      C.valueAt(r as never, t),
      spec(CUB_T, f32(CUB_R), 4, 'CUBICSPLINE', t, true),
      `rotation at ${t}`,
    )
    near(C.valueAt(w as never, t), spec(CUB_T, f32(CUB_W), 2, 'CUBICSPLINE', t), `weights at ${t}`)
  }
  // Outside the keys: the first and last values, not their tangents.
  near(C.valueAt(p as never, -5), [0, 0, 0], 'before the first key')
  near(C.valueAt(p as never, 9), [1, 3, 2], 'after the last key')
})

test('motion-gltf-clips: refuses what the spec does not allow, by name', async () => {
  const back = fixture()
  ;(back.animations[0]?.samplers[0] as Json).input = 3 // zeros: times that do not ascend
  await assert.rejects(
    async () => C.readClips(await open(back)),
    /animations\[0\]\.samplers\[0\]\.input key 1/,
  )
  const short = fixture()
  ;(short.animations[0]?.samplers[0] as Json).output = 0
  await assert.rejects(
    async () => C.readClips(await open(short)),
    /animations\[0\]\.samplers\[0\]\.output holds 3 numbers: 3 keys × 1 × 3 for translation/,
  )
  const odd = fixture()
  ;(odd.animations[1]?.samplers[0] as Json).interpolation = 'EASE'
  await assert.rejects(
    async () => C.readClips(await open(odd)),
    /samplers\[0\]\.interpolation is EASE/,
  )
  const nowhere = fixture()
  ;(nowhere.animations[0]?.channels[0] as Json).target = { node: 9, path: 'translation' }
  await assert.rejects(async () => C.readClips(await open(nowhere)), /target\.node is 9, no node/)
  const ch = C.readClips(await open(fixture())).clips[0]?.channels[0] as never
  assert.throws(() => C.valueAt(ch, Number.NaN), /valueAt: t is NaN, not a number of seconds/)
  // loadClips reads through the host, as a film does.
  const bytes = new TextEncoder().encode(JSON.stringify(fixture()))
  const host = { io: { read: async () => bytes } }
  assert.equal((await C.loadClips(host, 'assets/rig.gltf')).clips.length, 3)
})
