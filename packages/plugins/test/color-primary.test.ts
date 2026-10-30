// color-primary, on the CPU and headless on Dawn. Checked: every default is identity; the ASC CDL
// gives the values worked by hand from the v1.2 formula, its clamp before the power and after the
// saturation included; Bradford gives Lindbloom's published D50 and D65 matrices; Kelvin gives D65
// and illuminant A; and the WGSL gives the CPU's values within one 8-bit step.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBuffer } from '@shaderera/core/gpu'
import {
  applyMatrix,
  bradford,
  cdl,
  contrast,
  D65,
  exposure,
  kelvinToXy,
  type Mat3,
  toMat3x3f,
  whiteBalance,
} from '../color-primary/src/color/primary.ts'
import { PRIMARY_WGSL } from '../color-primary/src/color/primary.wgsl.ts'
import { openFrame } from './frame.ts'

type Rgb = readonly [number, number, number]

const near = (got: readonly number[], want: readonly number[], what: string, eps = 1e-12) =>
  assert.ok(
    got.length === want.length && got.every((v, i) => Math.abs(v - (want[i] ?? Number.NaN)) <= eps),
    `${what}: ${got} is not ${want}`,
  )

const spread = (n: number): Rgb[] =>
  Array.from({ length: n }, (_, i) => [
    (i * 0.6180339) % 1,
    (i * 0.4142135) % 1,
    (i * 0.7320508) % 1,
  ])

test('color-primary: every default is identity on 0–1', () => {
  for (const c of spread(200)) {
    near(cdl(c), c, `cdl(${c})`)
    near(exposure(c), c, `exposure(${c})`)
    near(contrast(c), c, `contrast(${c})`, 1e-15)
    near(applyMatrix(whiteBalance(), c), c, `whiteBalance(${c})`, 1e-15)
  }
  // Light past 1 and below 0 goes through exposure, contrast and white balance untouched; the CDL
  // clamps it to 0–1, as v1.2 does.
  near(contrast([-0.05, 0.2, 0.3]), [-0.05, 0.2, 0.3], 'contrast below 0', 1e-15)
  near(cdl([4, 0.5, -1]), [1, 0.5, 0], 'the CDL clamps')
  near(exposure([4, 0.5, 12]), [4, 0.5, 12], 'exposure above 1')
  near(contrast([4, 0.5, 12]), [4, 0.5, 12], 'contrast above 1', 1e-14)
  near(whiteBalance(), [1, 0, 0, 0, 1, 0, 0, 0, 1], 'D65 to D65', 1e-15)
})

test('color-primary: the ASC CDL gives the values worked by hand', () => {
  // Slope and offset: 0.5 × (1.2, 1, 0.8) + (0.05, 0, -0.1).
  near(cdl([0.5, 0.5, 0.5], [1.2, 1, 0.8], [0.05, 0, -0.1]), [0.65, 0.5, 0.3], 'slope, offset')
  // Power: 0.5^2, 0.5^1, 0.5^0.5.
  near(cdl([0.5, 0.5, 0.5], [1, 1, 1], [0, 0, 0], [2, 1, 0.5]), [0.25, 0.5, Math.SQRT1_2], 'power')
  // The clamp comes before the power: 1.8 is 1 and -0.1 is 0, so 1 and 0, not 1.342 and NaN.
  near(
    cdl([0.9, 0.1, 0.5], [2, 1, 1], [0, -0.2, 0], [0.5, 0.5, 0.5]),
    [1, 0, Math.SQRT1_2],
    'clamp before power',
  )
  // Saturation 0 is the Rec.709 luma: 0.2126 × 0.6 + 0.7152 × 0.4 + 0.0722 × 0.2 = 0.42808.
  near(
    cdl([0.6, 0.4, 0.2], undefined, undefined, undefined, 0),
    [0.42808, 0.42808, 0.42808],
    'sat 0',
  )
  // Saturation 2: 0.42808 + 2 (c - 0.42808), and blue's -0.02808 is clamped to 0 after it.
  near(cdl([0.6, 0.4, 0.2], undefined, undefined, undefined, 2), [0.77192, 0.37192, 0], 'sat 2')
  // Slope first, then saturation on its result: (1, 0.5, 0.25) has luma 0.58825, and saturation
  // 0.5 halves each channel's distance from it.
  near(
    cdl([0.5, 0.25, 0.125], [2, 2, 2], undefined, undefined, 0.5),
    [0.794125, 0.544125, 0.419125],
    'SOP then saturation',
    1e-15,
  )
})

test('color-primary: exposure and contrast', () => {
  near(exposure([0.18, 1, 0.5], 1), [0.36, 2, 1], '+1 stop')
  near(exposure([0.18, 1, 0.5], -2), [0.045, 0.25, 0.125], '-2 stops')
  // Contrast 2 around 0.18: a stop above the pivot becomes two, a stop below becomes two below.
  near(contrast([0.36, 0.18, 0.09], 2), [0.72, 0.18, 0.045], 'contrast 2', 1e-15)
  near(
    contrast([0.5, -1, 0.25], 0.5, 0.5),
    [0.5, -1, Math.SQRT1_2 / 2],
    'contrast 0.5, pivot 0.5: a negative passes through',
    1e-15,
  )
  near(contrast([0, -0.2, 0.18], 3), [0, -0.2, 0.18], '0 and below pass through')
  assert.throws(() => contrast([0.5, 0.5, 0.5], 2, 0), /pivot must be above 0, not 0/)
  assert.throws(() => contrast([0.5, 0.5, 0.5], 2, -0.1), /pivot must be above 0/)
})

test('color-primary: Bradford gives the published matrices', () => {
  // Bruce Lindbloom's Bradford matrices (brucelindbloom.com, Chromatic Adaptation), with his
  // whites: D65 XYZ (0.95047, 1, 1.08883), D50 XYZ (0.96422, 1, 0.82521).
  const xy = (x: number, y: number, z: number) => [x / (x + y + z), y / (x + y + z)] as const
  const d65 = xy(0.95047, 1, 1.08883)
  const d50 = xy(0.96422, 1, 0.82521)
  const d65ToD50: Mat3 = [
    1.0478112, 0.0228866, -0.050127, 0.0295424, 0.9904844, -0.0170491, -0.0092345, 0.0150436,
    0.7521316,
  ]
  const d50ToD65: Mat3 = [
    0.9555766, -0.0230393, 0.0631636, -0.0282895, 1.0099416, 0.0210077, 0.0122982, -0.020483,
    1.3299098,
  ]
  near(bradford(d65, d50), d65ToD50, 'D65 to D50', 5e-7)
  near(bradford(d50, d65), d50ToD65, 'D50 to D65', 5e-7)
  near(bradford(d50), bradford(d50, D65), 'the target is D65 by default', 0)

  // White balance in Rec.709: the source white's own RGB comes out as the target's, which is
  // equal RGB for D65; and from a warm source, blue is lifted and red lowered.
  const warm = kelvinToXy(3200)
  const m = whiteBalance(warm)
  const xyzWarm: Rgb = [warm[0] / warm[1], 1, (1 - warm[0] - warm[1]) / warm[1]]
  const toRgb: Mat3 = [
    3.2409699, -1.5373832, -0.4986108, -0.9692436, 1.8759675, 0.0415551, 0.0556301, -0.203977,
    1.0569715,
  ]
  const [r, g, b] = applyMatrix(m, applyMatrix(toRgb, xyzWarm))
  near([r / g, b / g], [1, 1], 'the source white becomes grey', 1e-6)
  const [wr, , wb] = applyMatrix(m, [0.5, 0.5, 0.5])
  assert.ok(wr < 0.5 && wb > 0.5, `3200 K to D65 moves grey to blue: ${wr}, ${wb}`)
})

test('color-primary: Kelvin to xy', () => {
  // The Planckian locus, against published black-body xy (CIE 1931 2°; illuminant A is 2856 K).
  // 6504 K is the black body, not D65, which sits above the locus.
  near(kelvinToXy(6504), [0.3135, 0.3236], '6504 K on the Planckian locus', 1e-3)
  near(kelvinToXy(2856), [0.4476, 0.4074], '2856 K is illuminant A', 1e-3)
  near(kelvinToXy(5000), [0.3451, 0.3516], '5000 K', 1e-3)
  assert.ok(D65[1] - kelvinToXy(6504)[1] > 0.005, 'D65 is above the locus')
  // No jump where the spline's pieces meet, at 2222 K and 4000 K.
  for (const seam of [2222, 4000])
    near(kelvinToXy(seam - 1e-6), kelvinToXy(seam), `continuous at ${seam} K`, 1e-4)
  assert.throws(() => kelvinToXy(1000), /1000 K is out of range: 1667–25000/)
  assert.throws(() => kelvinToXy(Number.NaN), /out of range/)
})

test('color-primary: the WGSL gives the CPU values, within one 8-bit step', async () => {
  const wb = whiteBalance(kelvinToXy(3200))
  const grade = (c: Rgb) => {
    const lit = contrast(exposure(applyMatrix(wb, c), 0.75), 1.3, 0.18)
    return [
      lit,
      cdl(c, [1.1, 0.95, 0.8], [0.02, -0.01, 0.05], [0.9, 1.2, 1.05], 1.25),
      cdl(lit, [1.1, 0.95, 0.8], [0.02, -0.01, 0.05], [0.9, 1.2, 1.05], 0.6),
    ]
  }
  const inputs: Rgb[] = [...spread(4000), [0, 0, 0], [1, 1, 1], [-0.5, 2, 0.5], [4, 0.1, 12]]
  const n = inputs.length
  const gpu = await openFrame(1, 1)
  const module = gpu.device.createShaderModule({
    code: `${PRIMARY_WGSL}
@group(0) @binding(0) var<storage, read> src: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(2) var<uniform> wb: mat3x3f;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&src)) { return; }
  let c = src[i].rgb;
  let lit = contrast(exposure(wb * c, 0.75), 1.3, 0.18);
  let slope = vec3f(1.1, 0.95, 0.8);
  let offset = vec3f(0.02, -0.01, 0.05);
  let power = vec3f(0.9, 1.2, 1.05);
  dst[3u * i] = vec4f(lit, 0.0);
  dst[3u * i + 1u] = vec4f(cdl(c, slope, offset, power, 1.25), 0.0);
  dst[3u * i + 2u] = vec4f(cdl(lit, slope, offset, power, 0.6), 0.0);
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
  const matrix = gpu.device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  gpu.device.queue.writeBuffer(matrix, 0, toMat3x3f(wb))
  const dst = gpu.device.createBuffer({
    size: n * 48,
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
        { binding: 2, resource: { buffer: matrix } },
      ],
    }),
  )
  pass.dispatchWorkgroups(Math.ceil(n / 64))
  pass.end()
  gpu.device.queue.submit([encoder.finish()])
  const out = new Float32Array((await readBuffer(gpu.device, dst)).buffer)

  const names = ['white balance, exposure, contrast', 'cdl', 'all four']
  inputs.forEach((c, i) => {
    // The CPU in float32's input, as the GPU read it.
    const f = c.map(Math.fround) as unknown as Rgb
    for (const [k, cpu] of grade(f).entries())
      for (let ch = 0; ch < 3; ch++) {
        const got = out[(3 * i + k) * 4 + ch] ?? Number.NaN
        const d = Math.abs(got - (cpu[ch] ?? 0)) * 255
        assert.ok(d <= 1, `${names[k]}(${c}) channel ${ch}: ${got} vs ${cpu[ch]}`)
      }
  })
  gpu.done()
})
