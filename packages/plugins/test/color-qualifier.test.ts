// color-qualifier, laid out the way `add` lays it out, on the CPU and headless on Dawn.
// Checked: a key with no ranges passes everything; a hue range across 0° keys reds both sides of
// it; softness 0 is a hard key and softness > 0 a smoothstep ramp, monotone, exactly 0 and 1
// outside and inside; a hue wheel and a grey ramp give the expected mattes; the hue is
// color-curves' own; and the WGSL gives the CPU's matte within one 8-bit step.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBuffer } from '@shaderera/core/gpu'
import { hueOf } from '../color-curves/src/color/curves.ts'
import { openFrame } from './frame.ts'
import { layOut } from './lay-out.ts'

const load = layOut('color-qualifier')
const { keyUniform, qualify } = (await load(
  'src/color/qualifier.ts',
)) as typeof import('../color-qualifier/src/color/qualifier.ts')
const { QUALIFIER_WGSL } = (await load(
  'src/color/qualifier.wgsl.ts',
)) as typeof import('../color-qualifier/src/color/qualifier.wgsl.ts')
type Key = import('../color-qualifier/src/color/qualifier.ts').Key

type Rgb = readonly [number, number, number]

const colours: Rgb[] = Array.from({ length: 2000 }, (_, i) => [
  (i * 0.6180339) % 1,
  (i * 0.4142135) % 1,
  (i * 0.7320508) % 1,
])

// A fully saturated colour at an HSV hue in degrees, at value 1.
const atHue = (deg: number): Rgb => {
  const h = (((deg / 60) % 6) + 6) % 6
  const s = [Math.abs(h - 3) - 1, 2 - Math.abs(h - 2), 2 - Math.abs(h - 4)]
  return s.map((v) => Math.min(Math.max(v, 0), 1)) as unknown as Rgb
}
const grey = (v: number): Rgb => [v, v, v]
// Rec.709 luma, summed in the plugin's order, so a grey's edges land exactly where its own do.
const lumaOf = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b

test('color-qualifier: a key with no ranges passes everything', () => {
  for (const c of [...colours, grey(0), grey(1), [2, 0.5, -0.1] as Rgb])
    assert.equal(qualify(c, {}), 1, `at ${c}`)
  // A hue range as wide as the wheel passes every hue.
  for (const c of colours) assert.equal(qualify(c, { hue: { centreDeg: 77, widthDeg: 360 } }), 1)
})

test('color-qualifier: the hue is color-curves’ own, so a range keys what a curve turns', () => {
  const key: Key = { hue: { centreDeg: 0, widthDeg: 0, softnessDeg: 180 } }
  for (const c of colours) {
    const d = Math.min(hueOf(c), 360 - hueOf(c)) / 180
    const want = 1 - d * d * (3 - 2 * d)
    assert.ok(Math.abs(qualify(c, key) - want) < 1e-12, `at ${c}`)
  }
  // analysis-scopes' skin line, 123° from +Cb to +Cr in BT.709, is about 18.5° in this hue.
  const [cb, cr] = [Math.cos((123 * Math.PI) / 180), Math.sin((123 * Math.PI) / 180)]
  const k = 0.05
  const skin: Rgb = [
    0.5 + 1.5748 * k * cr,
    0.5 - k * (0.1873 * cb + 0.4681 * cr),
    0.5 + 1.8556 * k * cb,
  ]
  assert.ok(Math.abs(hueOf(skin) - 18.5) < 0.1, `the skin line at ${hueOf(skin)}°`)
})

test('color-qualifier: a hue range across 0° keys reds on both sides of 0', () => {
  const key: Key = { hue: { centreDeg: 350, widthDeg: 40 } }
  for (const deg of [331, 340, 350, 359, 0, 5, 9])
    assert.equal(qualify(atHue(deg), key), 1, `${deg}°`)
  for (const deg of [329, 11, 60, 180, 300]) assert.equal(qualify(atHue(deg), key), 0, `${deg}°`)
  // The centre may be given the other way round the wheel: -10° is 350°.
  for (const deg of [0, 90, 200, 335, 355])
    assert.equal(
      qualify(atHue(deg), { hue: { centreDeg: -10, widthDeg: 40 } }),
      qualify(atHue(deg), key),
    )
})

test('color-qualifier: softness 0 is hard; softness > 0 a smooth ramp, exactly 0 and 1 beyond it', () => {
  const xs = Array.from({ length: 1001 }, (_, i) => i / 1000)
  // Luma on a grey ramp: inside 0.4–0.6 is 1, the ramps 0.3–0.4 and 0.6–0.7.
  const luma = (s: number): Key => ({ luma: { low: 0.4, high: 0.6, softness: s } })
  for (const x of xs) {
    const l = lumaOf(grey(x))
    assert.equal(qualify(grey(x), luma(0)), l >= 0.4 && l <= 0.6 ? 1 : 0, `hard at ${x}`)
  }
  const soft = xs.map((x) => qualify(grey(x), luma(0.1)))
  xs.forEach((x, i) => {
    const [m, l] = [soft[i] ?? Number.NaN, lumaOf(grey(x))]
    if (l <= 0.3 || l >= 0.7) assert.equal(m, 0, `outside at ${x}`)
    else if (l >= 0.4 && l <= 0.6) assert.equal(m, 1, `inside at ${x}`)
    else assert.ok(m > 0 && m < 1, `on the ramp at ${x}: ${m}`)
    // Up to the middle it rises, then it falls.
    if (i > 0) assert.ok(x <= 0.5 ? m >= (soft[i - 1] ?? 0) : m <= (soft[i - 1] ?? 0), `at ${x}`)
  })
  // Half way up the edge is a half, and the ramp is smoothstep's: flat at both ends.
  assert.ok(Math.abs((soft[350] ?? 0) - 0.5) < 1e-12, 'half way up the edge')
  assert.ok((soft[301] ?? 1) < 0.001 && (soft[399] ?? 0) > 0.999, 'flat at the ends of the edge')

  // Saturation ramps the same way: [1, 1 - x, 1 - x] has an HSV saturation of x.
  const sat = xs.map((x) =>
    qualify([1, 1 - x, 1 - x], { saturation: { low: 0.5, high: 1, softness: 0.2 } }),
  )
  xs.forEach((x, i) => {
    const m = sat[i] ?? Number.NaN
    if (x < 0.29) assert.equal(m, 0, `saturation below at ${x}`)
    else if (x > 0.51) assert.equal(m, 1, `saturation inside at ${x}`)
    if (i > 0) assert.ok(m >= (sat[i - 1] ?? 0), `saturation monotone at ${x}`)
  })
  // And hue, both ways from the centre.
  const degs = Array.from({ length: 361 }, (_, i) => i - 180)
  const hue = degs.map((d) =>
    qualify(atHue(d), { hue: { centreDeg: 0, widthDeg: 20, softnessDeg: 30 } }),
  )
  degs.forEach((d, i) => {
    const m = hue[i] ?? Number.NaN
    if (Math.abs(d) < 10) assert.equal(m, 1, `hue inside at ${d}`)
    else if (Math.abs(d) > 40) assert.equal(m, 0, `hue outside at ${d}`)
    else if (Math.abs(d) > 10 && Math.abs(d) < 40) assert.ok(m > 0 && m < 1, `hue ramp at ${d}`)
    const last = hue[i - 1] ?? 0
    if (i > 0) assert.ok(d <= 0 ? m >= last : m <= last, `hue monotone at ${d}`)
  })
  assert.throws(() => qualify(grey(0.5), luma(-0.1)), /softness/)
  assert.throws(
    () => keyUniform({ hue: { centreDeg: 0, widthDeg: 10, softnessDeg: -1 } }),
    /softness/,
  )
})

test('color-qualifier: a hue wheel and a grey ramp give the expected mattes', () => {
  // A wheel of hues, keyed to greens 90–150° with 10° soft edges, saturation over 0.2.
  const key: Key = {
    hue: { centreDeg: 120, widthDeg: 60, softnessDeg: 10 },
    saturation: { low: 0.2, high: 1 },
  }
  for (let deg = 0; deg < 360; deg += 0.5) {
    const m = qualify(atHue(deg), key)
    if (deg >= 90 && deg <= 150) assert.equal(m, 1, `${deg}°`)
    else if (deg < 80 || deg > 160) assert.equal(m, 0, `${deg}°`)
    else if (deg > 80 && deg < 160) assert.ok(m > 0 && m < 1, `${deg}°`)
    // The same hue washed out under the saturation's low is out.
    const [r, g, b] = atHue(deg)
    assert.equal(qualify([0.9 + 0.1 * r, 0.9 + 0.1 * g, 0.9 + 0.1 * b], key), 0, `pale ${deg}°`)
  }
  // A grey ramp, keyed on the shadows: Rec.709 luma up to 0.25, soft to 0.35.
  const shadows: Key = { luma: { low: 0, high: 0.25, softness: 0.1 } }
  for (let i = 0; i <= 255; i++) {
    const [l, m] = [lumaOf(grey(i / 255)), qualify(grey(i / 255), shadows)]
    if (l <= 0.25) assert.equal(m, 1, `grey ${i}`)
    else if (l >= 0.35) assert.equal(m, 0, `grey ${i}`)
    else assert.ok(m > 0 && m < qualify(grey((i - 1) / 255), shadows), `grey ${i} falls`)
  }
  // Luma is Rec.709's: pure green (0.7152) is a highlight, pure blue (0.0722) is not.
  const highlights: Key = { luma: { low: 0.5, high: 1 } }
  assert.equal(qualify([0, 1, 0], highlights), 1)
  assert.equal(qualify([0, 0, 1], highlights), 0)
  // A grey's hue is 0°, as hueOf says: a red key with no saturation range keys greys too, and a
  // saturation low takes them out.
  const red: Key = { hue: { centreDeg: 0, widthDeg: 30 } }
  assert.equal(qualify(grey(0.5), red), 1)
  assert.equal(qualify(grey(0.5), { ...red, saturation: { low: 0.1, high: 1 } }), 0)
})

test('color-qualifier: the WGSL gives the CPU matte, within one 8-bit step', async () => {
  const keys: Key[] = [
    {},
    { hue: { centreDeg: 350, widthDeg: 40, softnessDeg: 15 } },
    { hue: { centreDeg: 120, widthDeg: 60 }, saturation: { low: 0.3, high: 0.9, softness: 0.1 } },
    { luma: { low: 0.2, high: 0.6, softness: 0.15 } },
    {
      hue: { centreDeg: 20, widthDeg: 30, softnessDeg: 20 },
      saturation: { low: 0.1, high: 0.6, softness: 0.05 },
      luma: { low: 0.3, high: 0.9, softness: 0.1 },
    },
  ]
  const inputs: Rgb[] = [...colours, grey(0), grey(1), grey(0.5), [1, 0, 0], [0, 1, 1]]
  const n = inputs.length
  const gpu = await openFrame(1, 1)
  const module = gpu.device.createShaderModule({
    code: `${QUALIFIER_WGSL}
@group(0) @binding(0) var<storage, read> src: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<uniform> key: QualifierKey;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&src)) { return; }
  dst[id.x] = qualify(src[id.x].rgb, key);
}`,
  })
  const pipeline = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  })
  const src = gpu.device.createBuffer({
    size: n * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  gpu.device.queue.writeBuffer(src, 0, new Float32Array(inputs.flatMap((c) => [...c, 0])))
  for (const key of keys) {
    const uniform = gpu.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    gpu.device.queue.writeBuffer(uniform, 0, keyUniform(key))
    const dst = gpu.device.createBuffer({
      size: n * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })
    const encoder = gpu.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(
      0,
      gpu.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: src } },
          { binding: 1, resource: { buffer: dst } },
          { binding: 2, resource: { buffer: uniform } },
        ],
      }),
    )
    pass.dispatchWorkgroups(Math.ceil(n / 64))
    pass.end()
    gpu.device.queue.submit([encoder.finish()])
    const out = new Float32Array((await readBuffer(gpu.device, dst)).buffer)
    inputs.forEach((c, i) => {
      const cpu = qualify(c.map(Math.fround) as unknown as Rgb, key)
      const got = out[i] ?? Number.NaN
      assert.ok(Math.abs(got - cpu) * 255 <= 1, `${JSON.stringify(key)} at ${c}: ${got} vs ${cpu}`)
    })
  }
  gpu.done()
})
