// color-curves, laid out with the color-lut it bakes into, on the CPU and headless on Dawn.
// Checked: no points and the identity points are identity; the spline passes through its points,
// never goes past them (a staircase and an S-curve, densely) and is flat beyond the ends; the hue
// curves join at 0/360° with the same value and slope; a hue vs saturation of 0 at red turns pure
// red grey and leaves cyan alone; and the WGSL gives the CPU's values within one 8-bit step.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBuffer } from '@shaderera/core/gpu'
import { openFrame } from './frame.ts'
import { layOut } from './lay-out.ts'

const load = layOut('color-curves')
const { applyHueCurves, curvesLut, hueCurvesLut, hueSpline, spline } = (await load(
  'src/color/curves.ts',
)) as typeof import('../color-curves/src/color/curves.ts')
const { CURVES_WGSL } = (await load(
  'src/color/curves.wgsl.ts',
)) as typeof import('../color-curves/src/color/curves.wgsl.ts')
const { applyLut, lutTexture } = (await load(
  'src/color/lut.ts',
)) as typeof import('../color-lut/src/color/lut.ts')
const { LUT_WGSL } = (await load(
  'src/color/lut.wgsl.ts',
)) as typeof import('../color-lut/src/color/lut.wgsl.ts')

type Rgb = readonly [number, number, number]
type Point = readonly [number, number]

const near = (got: readonly number[], want: readonly number[], what: string, eps = 1e-12) =>
  assert.ok(
    got.every((v, i) => Math.abs(v - (want[i] ?? Number.NaN)) <= eps),
    `${what}: ${got} is not ${want}`,
  )

const colours: Rgb[] = Array.from({ length: 2000 }, (_, i) => [
  (i * 0.6180339) % 1,
  (i * 0.4142135) % 1,
  (i * 0.7320508) % 1,
])

test('color-curves: no points and the identity points are identity', () => {
  const straight: Point[] = [
    [0, 0],
    [1, 1],
  ]
  for (const f of [spline([]), spline(straight), spline([...straight, [0.5, 0.5]])])
    for (let i = 0; i <= 1000; i++) near([f(i / 1000)], [i / 1000], `at ${i / 1000}`)
  for (const lut of [curvesLut({}), curvesLut({ master: straight, red: straight, blue: [] })]) {
    assert.equal(lut.dimensions, 1)
    for (const c of colours) near(applyLut(lut, c), c, `RGB curves at ${c}`)
  }
  for (const lut of [
    hueCurvesLut({}),
    hueCurvesLut({ hueVsSat: [[120, 1]], hueVsHue: [[0, 0]] }),
    hueCurvesLut({
      hueVsSat: [
        [0, 1],
        [180, 1],
      ],
    }),
  ])
    for (const c of colours) near(applyHueCurves(lut, c), c, `hue curves at ${c}`)
})

test('color-curves: the spline is exact at its points, never past them, flat beyond the ends', () => {
  const staircase: Point[] = [
    [0.1, 0],
    [0.3, 0],
    [0.35, 0.5],
    [0.6, 0.5],
    [0.62, 0.9],
    [0.9, 1],
  ]
  const s: Point[] = [
    [0, 0],
    [0.25, 0.1],
    [0.5, 0.5],
    [0.75, 0.9],
    [1, 1],
  ]
  const wave: Point[] = [
    [0, 0.2],
    [0.2, 0.9],
    [0.4, 0.1],
    [0.45, 0.8],
    [1, 0.3],
  ]
  for (const [name, points] of [
    ['staircase', staircase],
    ['S-curve', s],
    ['wave', wave],
  ] as const) {
    // Given out of order: the spline sorts them.
    const f = spline([...points].reverse())
    for (const [x, y] of points) near([f(x)], [y], `${name} at its point ${x}`, 1e-15)
    for (let k = 0; k + 1 < points.length; k++) {
      const [x0, y0] = points[k] ?? [0, 0]
      const [x1, y1] = points[k + 1] ?? [0, 0]
      let last = y0
      for (let i = 0; i <= 1000; i++) {
        const y = f(x0 + ((x1 - x0) * i) / 1000)
        assert.ok(
          y >= Math.min(y0, y1) - 1e-15 && y <= Math.max(y0, y1) + 1e-15,
          `${name}: ${y} past ${y0}–${y1}`,
        )
        // Each piece runs one way: from one point to the next without turning back.
        assert.ok((y - last) * (y1 - y0) >= -1e-15, `${name}: turns back at ${y}`)
        last = y
      }
    }
    const [x0, y0] = points[0] ?? [0, 0]
    const [xn, yn] = points.at(-1) ?? [0, 0]
    for (const d of [1e-9, 0.01, 0.5, 10]) {
      assert.equal(f(x0 - d), y0, `${name} before the first point`)
      assert.equal(f(xn + d), yn, `${name} after the last point`)
    }
  }
  assert.throws(
    () =>
      spline([
        [0.5, 0],
        [0.5, 1],
      ]),
    /two points at 0.5/,
  )
})

test('color-curves: RGB curves bake the channel curve after the master', () => {
  const master: Point[] = [
    [0, 0.1],
    [1, 0.9],
  ]
  const red: Point[] = [
    [0, 0],
    [0.5, 0.7],
    [1, 1],
  ]
  const lut = curvesLut({ master, red }, 4097)
  const [m, r] = [spline(master), spline(red)]
  for (const c of colours) {
    const [mr, mg, mb] = c.map(m) as [number, number, number]
    near(applyLut(lut, c), [r(mr), mg, mb], `at ${c}`, 1e-6)
  }
})

test('color-curves: the hue curves join at 0/360° with the same value and slope', () => {
  const points: Point[] = [
    [20, 1.4],
    [90, 1.8],
    [200, 1],
    [330, 0.2],
  ]
  const f = hueSpline(points)
  for (const [x, y] of points) near([f(x)], [y], `at its point ${x}`, 1e-15)
  near([f(0), f(-360), f(720)], [f(360), f(360), f(360)], 'value at 0 and 360')
  const e = 1e-6
  const right = (f(e) - f(0)) / e
  const left = (f(360) - f(360 - e)) / e
  near([right], [left], 'slope at 0 and 360', 1e-4)
  assert.ok(Math.abs(right) > 1e-3, 'the slope is not 0 there')
  // The table over hue wraps the same way: its first and last entries sit either side of 0°.
  const lut = hueCurvesLut({ hueVsSat: points, hueVsHue: points }, 360)
  const at = (k: number) => lut.table[(((k % 360) + 360) % 360) * 3] ?? Number.NaN
  near([at(0)], [f(0)], 'the table at 0')
  near([at(0) - at(359)], [at(1) - at(0)], 'the table steps the same across 0', 1e-3)
  near([lut.table[1] ?? Number.NaN], [f(0)], 'the hue offsets, at 0')
})

test('color-curves: a hue vs saturation of 0 at red turns red grey and leaves cyan alone', () => {
  const lut = hueCurvesLut({
    hueVsSat: [
      [0, 0],
      [60, 1],
      [180, 1],
      [300, 1],
    ],
  })
  const grey = applyHueCurves(lut, [1, 0, 0])
  near(grey, [0.2126, 0.2126, 0.2126], 'red to its Rec.709 luma', 1e-15)
  near(applyHueCurves(lut, [0, 1, 1]), [0, 1, 1], 'cyan')
  near(applyHueCurves(lut, [0.2, 0.6, 0.6]), [0.2, 0.6, 0.6], 'a dark cyan')
  // Hue vs hue: red moved 120° is green, at the same HSV value and saturation.
  const turn = hueCurvesLut({ hueVsHue: [[0, 120]] })
  near(applyHueCurves(turn, [0.9, 0.3, 0.3]), [0.3, 0.9, 0.3], 'red turned to green')
  near(applyHueCurves(turn, [0.4, 0.4, 0.4]), [0.4, 0.4, 0.4], 'grey has no hue to turn')
})

test('color-curves: the WGSL gives the CPU values, within one 8-bit step', async () => {
  const rgb = curvesLut({
    master: [
      [0, 0],
      [0.25, 0.15],
      [0.75, 0.85],
      [1, 1],
    ],
    green: [
      [0, 0.05],
      [0.5, 0.45],
      [1, 0.95],
    ],
  })
  const hue = hueCurvesLut({
    hueVsSat: [
      [0, 0.3],
      [120, 1.5],
      [240, 0.8],
    ],
    hueVsHue: [
      [30, 25],
      [200, -40],
      [300, 0],
    ],
  })
  const inputs: Rgb[] = [...colours, [0, 0, 0], [1, 1, 1], [1, 0, 0], [0, 1, 1], [0.5, 0.5, 0.5]]
  const n = inputs.length
  const gpu = await openFrame(1, 1)
  const module = gpu.device.createShaderModule({
    code: `${LUT_WGSL}${CURVES_WGSL}
@group(0) @binding(0) var<storage, read> src: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(2) var rgbCurves: texture_2d<f32>;
@group(0) @binding(3) var hueCurves: texture_2d<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&src)) { return; }
  dst[2u * i] = vec4f(lut1d(rgbCurves, src[i].rgb, vec3f(0.0), vec3f(1.0)), 0.0);
  dst[2u * i + 1u] = vec4f(applyHueCurves(hueCurves, src[i].rgb), 0.0);
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
  const dst = gpu.device.createBuffer({
    size: n * 32,
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
        { binding: 2, resource: lutTexture(gpu.device, rgb).createView() },
        { binding: 3, resource: lutTexture(gpu.device, hue).createView() },
      ],
    }),
  )
  pass.dispatchWorkgroups(Math.ceil(n / 64))
  pass.end()
  gpu.device.queue.submit([encoder.finish()])
  const out = new Float32Array((await readBuffer(gpu.device, dst)).buffer)

  inputs.forEach((c, i) => {
    const f = c.map(Math.fround) as unknown as Rgb
    for (const [k, cpu] of [applyLut(rgb, f), applyHueCurves(hue, f)].entries())
      for (let ch = 0; ch < 3; ch++) {
        const got = out[(2 * i + k) * 4 + ch] ?? Number.NaN
        const d = Math.abs(got - (cpu[ch] ?? 0)) * 255
        assert.ok(d <= 1, `${k ? 'hue' : 'RGB'} curves (${c}) channel ${ch}: ${got} vs ${cpu[ch]}`)
      }
  })
  gpu.done()
})
