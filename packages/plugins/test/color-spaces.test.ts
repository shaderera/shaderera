// color-spaces, laid out with the color-primary it imports, on the CPU and headless on Dawn.
// Checked: ACEScct and ACEScc give the published values, meet at their breakpoints and round
// trip; BT.1886 is gamma 2.4; the AP0 and AP1 matrices are S-2014-004's; Rec.709 to AP0 is the
// published Bradford matrix OpenColorIO prints, and to AP1 that then AP0 to AP1; Rec.709 to
// Rec.2020 is BT.2087's and back BT.2407's; every gamut round trips and keeps white; and the
// WGSL gives the CPU's values within one 8-bit step, a gamut matrix from a uniform included.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBuffer } from '@shaderera/core/gpu'
import { openFrame } from './frame.ts'
import { layOut } from './lay-out.ts'

const load = layOut('color-spaces')
const {
  acesccToLinear,
  acescctToLinear,
  bt1886ToLinear,
  GAMUTS,
  gamutMatrix,
  linearToAcescc,
  linearToAcescct,
  linearToBt1886,
  rgbToXyz,
  xyzToRgb,
} = (await load('src/color/spaces.ts')) as typeof import('../color-spaces/src/color/spaces.ts')
const { SPACES_WGSL } = (await load(
  'src/color/spaces.wgsl.ts',
)) as typeof import('../color-spaces/src/color/spaces.wgsl.ts')
const { applyMatrix, mul, toMat3x3f } = (await load(
  'src/color/primary.ts',
)) as typeof import('../color-primary/src/color/primary.ts')

type Rgb = readonly [number, number, number]
type Mat3 = import('../color-primary/src/color/primary.ts').Mat3

const near = (got: number, want: number, what: string, eps = 1e-12) =>
  assert.ok(Math.abs(got - want) <= eps, `${what}: ${got} is not ${want}`)
const nearAll = (got: readonly number[], want: readonly number[], what: string, eps: number) =>
  got.forEach((v, i) => {
    near(v, want[i] ?? Number.NaN, `${what} [${i}]`, eps)
  })

// Linear light from 2^-20 to 2^15.9 in steps of 1/16 stop (under half float's 65504), with 0.
const stops = [0, ...Array.from({ length: 36 * 16 }, (_, i) => 2 ** (-20 + i / 16))]

test('color-spaces: ACEScct gives the S-2016-001 values, meets at the toe and round trips', () => {
  near(linearToAcescct(0.18), 0.4135884, 'mid grey', 5e-8)
  near(linearToAcescct(1), 9.72 / 17.52, 'white')
  near(linearToAcescct(0), 0.0729055341958355, 'black, the toe line at 0')
  // Both pieces give the same value at the breakpoint, 2^-7 linear, 0.155251141552511 coded.
  near(10.5402377416545 * 0.0078125 + 0.0729055341958355, (-7 + 9.72) / 17.52, 'the toe', 1e-14)
  near(linearToAcescct(0.0078125), 0.155251141552511, 'at the breakpoint', 1e-14)
  near(linearToAcescct(0.0078125 + 1e-12), 0.155251141552511, 'just past it', 1e-10)
  near(acescctToLinear(0.155251141552511), 0.0078125, 'back at the breakpoint', 1e-14)
  near(acescctToLinear(0.155251141552511 + 1e-12), 0.0078125, 'just past it', 1e-12)
  near(acescctToLinear(2), 65504, 'clamped to half float')
  for (const x of stops)
    near(acescctToLinear(linearToAcescct(x)), x, `round trip ${x}`, Math.max(x, 1e-3) * 1e-13)
  for (let i = 0; i <= 1000; i++) {
    const v = i / 1000
    near(linearToAcescct(acescctToLinear(v)), v, `coded ${v}`, 1e-13)
  }
})

test('color-spaces: ACEScc gives the S-2014-003 values and round trips', () => {
  near(linearToAcescc(0.18), 0.4135884, 'mid grey', 5e-8)
  near(linearToAcescc(0), (-16 + 9.72) / 17.52, 'black, the floor')
  near(linearToAcescc(-1), (-16 + 9.72) / 17.52, 'below 0, the floor')
  // The eased piece meets the log at 2^-15, both ways.
  near(linearToAcescc(2 ** -15), (-15 + 9.72) / 17.52, 'at 2^-15')
  near(linearToAcescc(2 ** -15 - 1e-15), (-15 + 9.72) / 17.52, 'just below it', 1e-10)
  near(acesccToLinear((9.72 - 15) / 17.52 - 1e-14), 2 ** -15, 'back, just below it', 1e-15)
  near(acesccToLinear(2), 65504, 'clamped to half float')
  for (const x of stops)
    near(acesccToLinear(linearToAcescc(x)), x, `round trip ${x}`, Math.max(x, 1e-3) * 1e-13)
})

test('color-spaces: BT.1886 is gamma 2.4', () => {
  near(bt1886ToLinear(0.5), 0.5 ** 2.4, 'half')
  near(bt1886ToLinear(1), 1, 'white')
  near(bt1886ToLinear(-0.1), 0, 'below 0')
  near(linearToBt1886(0.18), 0.18 ** (1 / 2.4), 'mid grey')
  for (let i = 0; i <= 1000; i++)
    near(linearToBt1886(bt1886ToLinear(i / 1000)), i / 1000, `round trip ${i / 1000}`, 1e-15)
})

test('color-spaces: the ACES matrices are the published ones', () => {
  const ap0ToAp1: Mat3 = [
    1.4514393161, -0.2365107469, -0.2149285693, -0.0765537734, 1.1762296998, -0.0996759264,
    0.0083161484, -0.0060324498, 0.9977163014,
  ]
  // S-2014-004 (ACES2065-1) and S-2014-004 / TB-2014-004 (AP1), to 10 places.
  nearAll(
    rgbToXyz('ap0'),
    [0.9525523959, 0, 0.0000936786, 0.3439664498, 0.7281660966, -0.0721325464, 0, 0, 1.0088251844],
    'AP0 to XYZ',
    1e-10,
  )
  nearAll(
    rgbToXyz('ap1'),
    [
      0.6624541811, 0.1340042065, 0.156187687, 0.2722287168, 0.6740817658, 0.0536895174,
      -0.0055746495, 0.0040607335, 1.0103391003,
    ],
    'AP1 to XYZ',
    1e-10,
  )
  nearAll(gamutMatrix('ap0', 'ap1'), ap0ToAp1, 'AP0 to AP1', 1e-10)
  // Linear Rec.709 / sRGB to ACES2065-1, D65 to the ACES white by Bradford, as OpenColorIO
  // prints it (lin_rec709_scene in OpenImageIO's interop-identities-config.ocio, 15 places; the
  // OCIO v2 demo config, 12). To ACEScg, the published AP0 to AP1 after it.
  const rec709ToAp0: Mat3 = [
    0.439632981919491, 0.382988698151554, 0.177378319928955, 0.0897764429588424, 0.813439428748981,
    0.0967841282921771, 0.0175411703831727, 0.111546553302387, 0.87091227631444,
  ]
  nearAll(gamutMatrix('rec709', 'ap0'), rec709ToAp0, 'Rec.709 to AP0', 1e-14)
  nearAll(gamutMatrix('rec709', 'ap1'), mul(ap0ToAp1, rec709ToAp0), 'Rec.709 to AP1', 1e-10)
})

test('color-spaces: Rec.709 to Rec.2020 is BT.2087, and back BT.2407', () => {
  // Both whites are D65, so no adaptation; the Recommendations print 4 places.
  nearAll(
    gamutMatrix('rec709', 'rec2020'),
    [0.6274, 0.3293, 0.0433, 0.0691, 0.9195, 0.0114, 0.0164, 0.088, 0.8956],
    'BT.2087',
    5e-5,
  )
  nearAll(
    gamutMatrix('rec2020', 'rec709'),
    [1.6605, -0.5876, -0.0728, -0.1246, 1.1329, -0.0083, -0.0182, -0.1006, 1.1187],
    'BT.2407',
    5e-5,
  )
})

test('color-spaces: every gamut round trips, and white stays white', () => {
  const names = Object.keys(GAMUTS) as (keyof typeof GAMUTS)[]
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  for (const a of names) {
    nearAll(mul(xyzToRgb(a), rgbToXyz(a)), identity, `${a} to XYZ and back`, 1e-14)
    // Each gamut's white, RGB 1, is its white point at Y = 1.
    const [x, y, z] = applyMatrix(rgbToXyz(a), [1, 1, 1])
    const [wx, wy] = GAMUTS[a].white
    nearAll([x / (x + y + z), y / (x + y + z), y], [wx, wy, 1], `${a} white`, 1e-14)
    for (const b of names) {
      nearAll(mul(gamutMatrix(b, a), gamutMatrix(a, b)), identity, `${a} to ${b} and back`, 1e-13)
      // White is white in any gamut: the adaptation carries one white to the other.
      nearAll(applyMatrix(gamutMatrix(a, b), [1, 1, 1]), [1, 1, 1], `${a} to ${b}, white`, 1e-12)
    }
  }
  nearAll(gamutMatrix(GAMUTS.p3d65, 'p3d65'), identity, 'a gamut given as data', 1e-14)
})

test('color-spaces: the WGSL gives the CPU values, within one 8-bit step', async () => {
  // Linear light from 2^-20 to 2^16 and 0, coded values over -0.5 to 1.6, and colours.
  const linear = stops
  const coded = Array.from({ length: 2101 }, (_, i) => -0.5 + i / 1000)
  const colours: Rgb[] = Array.from({ length: 500 }, (_, i) => [
    ((i * 0.6180339) % 1) * 4,
    ((i * 0.4142135) % 1) * 4,
    ((i * 0.7320508) % 1) * 4,
  ])
  const inputs = [...linear, ...coded].map(Math.fround)
  const n = inputs.length
  const m = gamutMatrix('rec709', 'ap1')
  const gpu = await openFrame(1, 1)
  const module = gpu.device.createShaderModule({
    code: `${SPACES_WGSL}
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(2) var<storage, read> rgb: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> graded: array<vec4f>;
@group(0) @binding(4) var<uniform> toAp1: mat3x3f;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i < arrayLength(&rgb)) { graded[i] = vec4f(linearToAcescct(toAp1 * rgb[i].rgb), 0.0); }
  if (i >= arrayLength(&src)) { return; }
  let x = vec3f(src[i]);
  dst[2u * i] = vec4f(linearToAcescct(x).r, acescctToLinear(x).r, linearToAcescc(x).r, acesccToLinear(x).r);
  dst[2u * i + 1u] = vec4f(bt1886ToLinear(x).r, linearToBt1886(x).r, 0.0, 0.0);
}`,
  })
  const pipeline = gpu.device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  })
  const storage = (data: Float32Array) => {
    const b = gpu.device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    gpu.device.queue.writeBuffer(b, 0, data)
    return b
  }
  const out = (size: number) =>
    gpu.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
  const src = storage(new Float32Array(inputs))
  const rgb = storage(new Float32Array(colours.flatMap((c) => [...c, 0])))
  const dst = out(n * 32)
  const graded = out(colours.length * 16)
  const matrix = gpu.device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  gpu.device.queue.writeBuffer(matrix, 0, toMat3x3f(m))
  const encoder = gpu.device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(
    0,
    gpu.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [src, dst, rgb, graded, matrix].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    }),
  )
  pass.dispatchWorkgroups(Math.ceil(n / 64))
  pass.end()
  gpu.device.queue.submit([encoder.finish()])
  const got = new Float32Array((await readBuffer(gpu.device, dst)).buffer)
  const gotGraded = new Float32Array((await readBuffer(gpu.device, graded)).buffer)

  // Coded and display values within 1/255; linear light within 1/255 of itself above 1, where an
  // 8-bit step of the coded value is a ratio, not a sum.
  const step = (cpu: number) => Math.max(1, Math.abs(cpu)) / 255
  const curves = [
    ['linearToAcescct', linearToAcescct],
    ['acescctToLinear', acescctToLinear],
    ['linearToAcescc', linearToAcescc],
    ['acesccToLinear', acesccToLinear],
    ['bt1886ToLinear', bt1886ToLinear],
    ['linearToBt1886', linearToBt1886],
  ] as const
  inputs.forEach((x, i) => {
    curves.forEach(([name, f], k) => {
      const cpu = f(x)
      const gpuValue = got[i * 8 + k] ?? Number.NaN
      assert.ok(Math.abs(gpuValue - cpu) <= step(cpu), `${name}(${x}): ${gpuValue} vs ${cpu}`)
    })
  })
  colours.forEach((c, i) => {
    const f = c.map(Math.fround) as unknown as Rgb
    const cpu = applyMatrix(m, f).map(linearToAcescct)
    for (let ch = 0; ch < 3; ch++) {
      const g = gotGraded[i * 4 + ch] ?? Number.NaN
      assert.ok(Math.abs(g - (cpu[ch] ?? 0)) <= 1 / 255, `Rec.709 to ACEScct (${c}) ${ch}: ${g}`)
    }
  })
  gpu.done()
})
