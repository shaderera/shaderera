// color-spaces, laid out with the color-primary it imports, on the CPU and headless on Dawn.
// Checked: ACEScct and ACEScc give the published values, meet at their breakpoints and round
// trip; BT.1886 is gamma 2.4; the AP0 and AP1 matrices are S-2014-004's; Rec.709 to AP0 is the
// published Bradford matrix OpenColorIO prints, and to AP1 that then AP0 to AP1; Rec.709 to
// Rec.2020 is BT.2087's and back BT.2407's; the camera curves give their vendors' code values
// and OpenColorIO 2.6's, and round trip; the camera gamuts are the primaries OCIO's matrices
// imply; every gamut round trips and keeps white; and the WGSL gives the CPU's values within one
// 8-bit step, a gamut matrix from a uniform included.

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
  clog3ToLinear,
  GAMUTS,
  gamutMatrix,
  linearToAcescc,
  linearToAcescct,
  linearToBt1886,
  linearToClog3,
  linearToLogc3,
  linearToLogc4,
  linearToSlog3,
  linearToVlog,
  logc3ToLinear,
  logc4ToLinear,
  rgbToXyz,
  slog3ToLinear,
  TO_LINEAR,
  vlogToLinear,
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

// The camera curves, by their FootageSpace transfer names: code value (10-bit code / 1023) to
// linear and back.
const cameras = {
  slog3: [slog3ToLinear, linearToSlog3],
  logc3: [logc3ToLinear, linearToLogc3],
  logc4: [logc4ToLinear, linearToLogc4],
  vlog: [vlogToLinear, linearToVlog],
  clog3: [clog3ToLinear, linearToClog3],
} as const

test('color-spaces: the camera curves give their vendors’ code values', () => {
  const code = (v: number) => v * 1023
  // Sony, S-Log3 technical summary: 0 is code 95, 18% grey 420, 90% white 598 (597.9).
  near(code(linearToSlog3(0)), 95, 'S-Log3 black', 1e-12)
  near(code(linearToSlog3(0.18)), 420, 'S-Log3 grey', 1e-12)
  near(code(linearToSlog3(0.9)), 598, 'S-Log3 white', 0.5)
  // ARRI, LogC3 (EI 800) and LogC4: 0 is 0.092809 and 95 / 1023, 18% grey 0.391007 and 0.278396.
  near(linearToLogc3(0), 0.092809, 'LogC3 black', 1e-12)
  near(linearToLogc3(0.18), 0.391007, 'LogC3 grey', 5e-7)
  near(linearToLogc4(0), 95 / 1023, 'LogC4 black', 1e-15)
  near(linearToLogc4(0.18), 0.278396, 'LogC4 grey', 5e-7)
  // Panasonic, V-Log: 0 is 0.125 (code 128), 18% grey 433, 90% white 602.
  near(linearToVlog(0), 0.125, 'V-Log black', 1e-15)
  near(code(linearToVlog(0.18)), 433, 'V-Log grey', 0.5)
  near(code(linearToVlog(0.9)), 602, 'V-Log white', 0.5)
  // Canon, Canon Log 3 (full range): 0 is 0.12512219 (code 128), 18% grey 351.
  near(linearToClog3(0), 0.12512219, 'Canon Log 3 black', 1e-15)
  near(code(linearToClog3(0.18)), 351, 'Canon Log 3 grey', 0.5)
  assert.deepEqual(TO_LINEAR, Object.fromEntries(Object.entries(cameras).map(([k, [f]]) => [k, f])))
})

test('color-spaces: the camera curves give OpenColorIO 2.6’s values and round trip', () => {
  // OCIO 2.6's built-ins on grey (SONY_SLOG3-SGAMUT3, ARRI_ALEXA-LOGC-EI800-AWG, ARRI_LOGC4,
  // PANASONIC_VLOG-VGAMUT _to_ACES2065-1, and CURVE - CANON_CLOG3_to_LINEAR, a 4096-entry LUT):
  // these 10-bit codes to linear, and these linear values to code values.
  const codes = [0, 64, 95, 128, 200, 300, 420, 512, 600, 700, 800, 940, 1023]
  const linear = [0, 0.001, 0.01, 0.18, 0.9, 1, 10, 30]
  const ocio = {
    slog3: [
      [
        -0.01402369421, -0.004576151259, 2.25026997e-9, 0.004871391226, 0.0173812788, 0.05604843795,
        0.1800004989, 0.4171395004, 0.917024374, 2.226137638, 5.383979321, 18.49461937, 38.42085266,
      ],
      [
        0.09286411107, 0.09948605299, 0.1590835452, 0.4105581641, 0.584453702, 0.5960275531,
        0.8506548405, 0.972543478,
      ],
    ],
    logc3: [
      [
        -0.01729048602, -0.00563528575, 0.00001020217769, 0.006019914988, 0.02124563791,
        0.06678979844, 0.2178348601, 0.5157688856, 1.16091013, 2.899685144, 7.221801758,
        25.86336327, 55.08014297,
      ],
      [
        0.0928093642, 0.09817701578, 0.1464859098, 0.3910059631, 0.5594325066, 0.5706307292,
        0.8169175386, 0.9347891808,
      ],
    ],
    logc4: [
      [
        -0.01805699617, -0.007939562201, 7.520597478e-8, 0.01181744877, 0.05729762465, 0.2159515768,
        0.8293013573, 2.21667695, 5.60673666, 16.00622177, 45.59666824, 197.2149048, 469.8012085,
      ],
      [
        0.09286496043, 0.09606787562, 0.120829463, 0.2783961296, 0.4179595113, 0.4275192022,
        0.6403896809, 0.7429094911,
      ],
    ],
    vlog: [
      [
        -0.02232130989, -0.01114970632, -0.005738460924, 0.00002189668339, 0.01277756505,
        0.0458881706, 0.1583913565, 0.3851792812, 0.8857570291, 2.262801886, 5.759784222,
        21.25839806, 46.08547592,
      ],
      [
        0.1249995679, 0.1305995733, 0.1809996665, 0.4233106375, 0.5881678462, 0.5991180539,
        0.839812398, 0.9549815655,
      ],
    ],
    // The LUT's last entry is linear 14.6683, so OCIO clamps linear 30 to code 1.
    clog3: [
      [
        -0.07381334156, -0.03037604317, -0.014726853, -2.037268132e-10, 0.03492082655, 0.1152511016,
        0.3057108521, 0.58274436, 1.042241573, 1.974452496, 3.695027351, 8.796042442, 14.66830158,
      ],
      [
        0.1251222044, 0.1273171753, 0.1470719725, 0.3433893621, 0.5644735694, 0.5802778006,
        0.9391973615,
      ],
    ],
  } as const
  // OCIO computes in float32, and its LogC3 takes ARRI's parameters to more places than ARRI's
  // EI 800 table prints (1e-5 apart at most, a thousandth of a 10-bit code coded).
  const eps = { slog3: 5e-6, logc3: 2e-5, logc4: 5e-6, vlog: 5e-6, clog3: 1e-6 }
  for (const [name, [decode, encode]] of Object.entries(cameras)) {
    const [toLinear, toCode] = ocio[name as keyof typeof ocio]
    const e = eps[name as keyof typeof eps]
    codes.forEach((c, i) => {
      const want = toLinear[i] ?? Number.NaN
      near(decode(c / 1023), want, `${name} code ${c}`, e * Math.max(1, Math.abs(want)))
    })
    toCode.forEach((want, i) => {
      near(encode(linear[i] ?? Number.NaN), want, `${name} linear ${linear[i]}`, e)
    })
    for (const x of stops.filter((x) => x < 2 ** 12))
      near(decode(encode(x)), x, `${name} round trip ${x}`, Math.max(x, 1e-3) * 1e-12)
    for (let i = 0; i <= 1000; i++) {
      const v = i / 1000
      near(encode(decode(v)), v, `${name} coded ${v}`, 1e-13)
    }
  }
})

test('color-spaces: the camera gamuts are the ones OpenColorIO 2.6 uses', () => {
  // Each camera gamut to linear Rec.709: OCIO 2.6's built-in matrix to AP0, then AP0 to XYZ, its
  // adaptation undone (CAT02, Bradford for V-Gamut) and XYZ to Rec.709. With no adaptation left,
  // it checks the primaries and the D65 white alone.
  const toRec709 = {
    sgamut3: [
      1.87791512840532, -0.79416876131438, -0.0837463670909435, -0.176806981309335,
      1.35099962089432, -0.174192639584984, -0.0262011264262913, -0.148422262344464,
      1.17462338877076,
    ],
    sgamut3cine: [
      1.62694740972908, -0.540138538869635, -0.0868088708594454, -0.178515527114877,
      1.41794092746408, -0.239425400349202, -0.0444361150092975, -0.195919966172016,
      1.24035608118131,
    ],
    awg3: [
      1.61752343630681, -0.537286622188293, -0.0802368141185126, -0.070572740897816,
      1.33461306233033, -0.264040321432512, -0.0211017280427935, -0.226953875218266,
      1.24805560326106,
    ],
    awg4: [
      1.89312344265271, -0.780881503616921, -0.112241939035791, -0.205700358252366,
      1.34025748938375, -0.134557131131387, -0.0127057429272714, -0.152184875796208,
      1.16489061872348,
    ],
    vgamut: [
      1.80657588372493, -0.695697274083699, -0.110878609641236, -0.1700903431024, 1.30595521609536,
      -0.135864872992964, -0.0252057840166403, -0.154468329360574, 1.17967411337721,
    ],
    cinemagamut: [
      1.92386129589855, -0.79876066324843, -0.125100632650121, -0.204310848200921, 1.49589850975094,
      -0.291587661550018, -0.0236850209703414, -0.42012701103027, 1.44381203200061,
    ],
  } as const
  for (const [name, m] of Object.entries(toRec709))
    nearAll(gamutMatrix(name as keyof typeof toRec709, 'rec709'), m, `${name} to Rec.709`, 1e-13)
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
  dst[4u * i] = vec4f(linearToAcescct(x).r, acescctToLinear(x).r, linearToAcescc(x).r, acesccToLinear(x).r);
  dst[4u * i + 1u] = vec4f(bt1886ToLinear(x).r, linearToBt1886(x).r, slog3ToLinear(x).r, linearToSlog3(x).r);
  dst[4u * i + 2u] = vec4f(logc3ToLinear(x).r, linearToLogc3(x).r, logc4ToLinear(x).r, linearToLogc4(x).r);
  dst[4u * i + 3u] = vec4f(vlogToLinear(x).r, linearToVlog(x).r, clog3ToLinear(x).r, linearToClog3(x).r);
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
  const dst = out(n * 64)
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
    ...Object.entries(cameras).flatMap(([name, [decode, encode]]) => [
      [`${name}ToLinear`, decode] as const,
      [`linear to ${name}`, encode] as const,
    ]),
  ] as const
  inputs.forEach((x, i) => {
    curves.forEach(([name, f], k) => {
      // A camera curve decodes code values only: linear light as its code is past a float's range.
      if (k >= 6 && k % 2 === 0 && i < linear.length) return
      const cpu = f(x)
      const gpuValue = got[i * 16 + k] ?? Number.NaN
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
