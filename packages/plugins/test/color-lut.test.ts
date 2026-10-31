// color-lut, on the CPU and headless on Dawn. Checked: an identity LUT gives back its input; a
// file read, written and read again is the same LUT; a 2³ LUT gives the tetrahedral values worked
// by hand, in each of the six tetrahedra; bad files are refused with what is wrong; and the WGSL
// gives the CPU's values within one 8-bit step, for a 33³ LUT read from a file and a 1D one.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBuffer } from '@shaderera/core/gpu'
import { applyLut, lutTexture, readCube, writeCube } from '../color-lut/src/color/lut.ts'
import { LUT_WGSL } from '../color-lut/src/color/lut.wgsl.ts'
import { openFrame } from './frame.ts'

type Rgb = readonly [number, number, number]

/** A 3D .cube file of size n from a function of the grid point, red fastest. */
const cube3 = (n: number, f: (c: Rgb) => Rgb, head = '') => {
  const rows: string[] = []
  for (let b = 0; b < n; b++)
    for (let g = 0; g < n; g++)
      for (let r = 0; r < n; r++) rows.push(f([r / (n - 1), g / (n - 1), b / (n - 1)]).join(' '))
  return `${head}LUT_3D_SIZE ${n}\n${rows.join('\n')}\n`
}

const near = (got: readonly number[], want: readonly number[], what: string, eps = 1e-12) =>
  assert.ok(
    got.every((v, i) => Math.abs(v - (want[i] ?? Number.NaN)) <= eps),
    `${what}: ${got} is not ${want}`,
  )

test('color-lut: an identity LUT gives back its input', () => {
  for (const n of [2, 17, 33]) {
    const lut = readCube(cube3(n, (c) => c))
    for (let i = 0; i < 500; i++) {
      // A spread of points that fall in every tetrahedron, and off the grid.
      const c: Rgb = [(i * 0.6180339) % 1, (i * 0.4142135) % 1, (i * 0.7320508) % 1]
      near(applyLut(lut, c), c, `${n}³ at ${c}`)
    }
    near(applyLut(lut, [1, 1, 1]), [1, 1, 1], `${n}³ at white`)
  }
  const line = readCube('LUT_1D_SIZE 3\n0 0 0\n0.5 0.5 0.5\n1 1 1\n')
  near(applyLut(line, [0.2, 0.7, 1]), [0.2, 0.7, 1], '1D')
})

test('color-lut: read, write and read again is the same LUT', () => {
  const text = `# made by hand
TITLE "Warm print"

DOMAIN_MIN 0 0 -0.125
DOMAIN_MAX 1 2 1.5
${cube3(3, ([r, g, b]) => [r * 0.9 + 0.013, g ** 2 / 3, 1 - b * 0.123456789012345])}`
  const lut = readCube(text)
  assert.equal(lut.title, 'Warm print')
  assert.deepEqual(lut.domainMin, [0, 0, -0.125])
  assert.deepEqual(lut.domainMax, [1, 2, 1.5])
  assert.equal(lut.table.length, 27 * 3)
  assert.deepStrictEqual(readCube(writeCube(lut)), lut)
  assert.equal(writeCube(readCube(writeCube(lut))), writeCube(lut))

  const line = readCube('LUT_1D_SIZE 2\n0.1 0.2 0.3\n0.9 0.8 0.7\n')
  assert.equal(line.dimensions, 1)
  assert.equal(line.title, undefined)
  assert.deepStrictEqual(readCube(writeCube(line)), line)
})

test('color-lut: tetrahedral interpolation gives the values worked by hand', () => {
  // A 2³ LUT whose red output at each corner is v, green v/2 and blue 1 - v:
  // c000 0, c100 0.1, c010 0.2, c110 0.5, c001 0.4, c101 0.6, c011 0.7, c111 1.
  const v: Record<string, number> = {
    '000': 0,
    '100': 0.1,
    '010': 0.2,
    '110': 0.5,
    '001': 0.4,
    '101': 0.6,
    '011': 0.7,
    '111': 1,
  }
  const lut = readCube(
    cube3(2, (c) => {
      const x = v[c.join('')] ?? Number.NaN
      return [x, x / 2, 1 - x]
    }),
  )
  const at = (c: Rgb, red: number, what: string) =>
    near(applyLut(lut, c), [red, red / 2, 1 - red], what, 1e-12)
  // r > g > b: c000 + r(c100 - c000) + g(c110 - c100) + b(c111 - c110) = 0.05 + 0.1 + 0.0625
  at([0.5, 0.25, 0.125], 0.2125, 'r > g > b')
  // r > b > g: r c100 + b(c101 - c100) + g(c111 - c101) = 0.05 + 0.125 + 0.05
  at([0.5, 0.125, 0.25], 0.225, 'r > b > g')
  // b > r > g: b c001 + r(c101 - c001) + g(c111 - c101) = 0.2 + 0.05 + 0.05
  at([0.25, 0.125, 0.5], 0.3, 'b > r > g')
  // g > r > b: g c010 + r(c110 - c010) + b(c111 - c110) = 0.1 + 0.075 + 0.0625
  at([0.25, 0.5, 0.125], 0.2375, 'g > r > b')
  // g > b > r: g c010 + b(c011 - c010) + r(c111 - c011) = 0.1 + 0.125 + 0.0375
  at([0.125, 0.5, 0.25], 0.2625, 'g > b > r')
  // b > g > r: b c001 + g(c011 - c001) + r(c111 - c011) = 0.2 + 0.075 + 0.0375
  at([0.125, 0.25, 0.5], 0.3125, 'b > g > r')
  // Trilinear would give 0.23125 at the first point: the plugin does not blend all eight corners.
  // Outside the domain the input is clamped to its edge.
  // (2, -1, 0.5) is (1, 0, 0.5): r > b > g, c100 + 0.5(c101 - c100) = 0.1 + 0.25
  at([2, -1, 0.5], 0.35, 'clamped')

  // The domain scales the input: DOMAIN_MAX 2 puts (1, 0.5, 0.25) where (0.5, 0.25, 0.125) was.
  const wide = { ...lut, domainMax: [2, 2, 2] as const }
  near(applyLut(wide, [1, 0.5, 0.25]), applyLut(lut, [0.5, 0.25, 0.125]), 'domain')

  // On a 5³ grid of x² per channel, 0.6 sits 0.4 of the way from 0.5 (0.25) to 0.75 (0.5625).
  const square = readCube(cube3(5, ([r, g, b]) => [r * r, g * g, b * b]))
  near(applyLut(square, [0.6, 0.6, 0.6]), [0.375, 0.375, 0.375], 'the cell at 2 of 4')

  // 1D: each channel on its own, linear between the two entries either side.
  const line = readCube('LUT_1D_SIZE 3\n0 0 1\n0.25 0.5 0.5\n1 1 0\n')
  near(applyLut(line, [0.25, 0.75, 0.5]), [0.125, 0.75, 0.5], '1D')
})

test('color-lut: a bad file says what is wrong', () => {
  assert.throws(() => readCube('0 0 0\n1 1 1\n'), /no LUT_3D_SIZE or LUT_1D_SIZE/)
  assert.throws(() => readCube('LUT_3D_SIZE 1\n0 0 0\n'), /LUT_3D_SIZE 1 is out of range: 2–256/)
  assert.throws(() => readCube('LUT_3D_SIZE 300\n'), /out of range: 2–256/)
  assert.throws(() => readCube('LUT_1D_SIZE 2.5\n'), /LUT_1D_SIZE 2.5 is out of range: 2–65536/)
  assert.throws(
    () => readCube(cube3(2, (c) => c).replace(/\n1 1 1\n$/, '\n')),
    /LUT_3D_SIZE 2 needs 8 rows, and the file has 7/,
  )
  assert.throws(() => readCube('LUT_1D_SIZE 2\n0 0\n1 1 1\n'), /line 2: .*three numbers/)
  assert.throws(() => readCube('LUT_1D_SIZE 2\n0 zero 0\n1 1 1\n'), /line 2: .*three numbers/)
  assert.throws(
    () => readCube(`LUT_1D_SIZE 2\n${cube3(2, (c) => c)}`),
    /both LUT_1D_SIZE and LUT_3D_SIZE/,
  )
  assert.throws(
    () => readCube('DOMAIN_MIN 0 1 0\nLUT_1D_SIZE 2\n0 0 0\n1 1 1\n'),
    /DOMAIN_MAX must be above DOMAIN_MIN/,
  )
  assert.throws(() => readCube('LUT_3D_SIZES 2\n'), /line 1: LUT_3D_SIZES is not a .cube keyword/)
})

test('color-lut: the WGSL gives the CPU values, within one 8-bit step', async () => {
  // A 33³ grade that mixes the channels and bends them, read from its file text; and a 1D curve.
  const lut = readCube(
    cube3(
      33,
      ([r, g, b]) => [0.8 * r + 0.2 * g * g, g ** 0.8 * (1 - 0.3 * b) + 0.1, 0.5 * (b + r * g)],
      'TITLE "Test grade"\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n',
    ),
  )
  const n1 = 1024
  const rows: string[] = []
  for (let i = 0; i < n1; i++) {
    const x = i / (n1 - 1)
    rows.push(`${x ** 2.2} ${Math.sqrt(x)} ${x * x * (3 - 2 * x)}`)
  }
  const line = readCube(`LUT_1D_SIZE ${n1}\nDOMAIN_MAX 1 1 2\n${rows.join('\n')}`)

  // A 24³ sweep of the cube, off the grid, and a few points outside it.
  const inputs: Rgb[] = []
  for (let b = 0; b < 24; b++)
    for (let g = 0; g < 24; g++)
      for (let r = 0; r < 24; r++) inputs.push([(r + 0.37) / 23.5, g / 23, (b + 0.81) / 24])
  inputs.push([0, 0, 0], [1, 1, 1], [-0.5, 2, 0.5], [1.5, -1, 3])
  const n = inputs.length
  const gpu = await openFrame(1, 1)
  const module = gpu.device.createShaderModule({
    code: `${LUT_WGSL}
@group(0) @binding(0) var<storage, read> src: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(2) var grade: texture_3d<f32>;
@group(0) @binding(3) var curve: texture_2d<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&src)) { return; }
  dst[2u * i] = vec4f(lut3d(grade, src[i].rgb, vec3f(0.0), vec3f(1.0)), 0.0);
  dst[2u * i + 1u] = vec4f(lut1d(curve, src[i].rgb, vec3f(0.0), vec3f(1.0, 1.0, 2.0)), 0.0);
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
        { binding: 2, resource: lutTexture(gpu.device, lut).createView() },
        { binding: 3, resource: lutTexture(gpu.device, line).createView() },
      ],
    }),
  )
  pass.dispatchWorkgroups(Math.ceil(n / 64))
  pass.end()
  gpu.device.queue.submit([encoder.finish()])
  const out = new Float32Array((await readBuffer(gpu.device, dst)).buffer)

  inputs.forEach((c, i) => {
    // The CPU in float32's input, as the GPU read it.
    const f = c.map(Math.fround) as unknown as Rgb
    for (const [k, cpu] of [applyLut(lut, f), applyLut(line, f)].entries())
      for (let ch = 0; ch < 3; ch++) {
        const got = out[(2 * i + k) * 4 + ch] ?? Number.NaN
        const d = Math.abs(got - (cpu[ch] ?? 0)) * 255
        assert.ok(d <= 1, `${k ? 'lut1d' : 'lut3d'}(${c}) channel ${ch}: ${got} vs ${cpu[ch]}`)
      }
  })
  gpu.done()
})
