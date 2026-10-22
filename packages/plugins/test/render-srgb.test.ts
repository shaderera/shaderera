// render-srgb, on the CPU and headless on Dawn. Checked: the curves give the IEC 61966-2-1 values
// and meet at the knee; encoding then decoding gives back the input; and the WGSL gives the CPU's
// values within one 8-bit step over 0–1, and every 8-bit code comes back through it.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBuffer } from '@shaderera/core/gpu'
import { toLinear, toSrgb } from '../render-srgb/src/render/srgb.ts'
import { SRGB_WGSL } from '../render-srgb/src/render/srgb.wgsl.ts'
import { openFrame } from './frame.ts'

const near = (got: number, want: number, what: string, eps = 1e-6) =>
  assert.ok(Math.abs(got - want) <= eps, `${what}: ${got} is not ${want}`)

test('render-srgb: the standard values, clamped encoding, a continuous knee', () => {
  near(toLinear(0), 0, 'black')
  near(toLinear(1), 1, 'white')
  near(toLinear(0.5), 0.214041, 'half a display value')
  near(toLinear(0.04045), 0.04045 / 12.92, 'the knee, decoded')
  near(toSrgb(0.5), 0.735357, 'half the light')
  near(toSrgb(0.18), 0.461356, 'middle grey')
  near(toSrgb(0.0031308), 0.0031308 * 12.92, 'the knee, encoded')
  near(toSrgb(2), 1, 'past white is white')
  near(toSrgb(-1), 0, 'below black is black')
  // Both pieces meet at the knee: the line and the power give the same value either side of it.
  near(((0.04045 + 0.055) / 1.055) ** 2.4, 0.04045 / 12.92, 'decoding, at the knee', 1e-7)
  near(1.055 * 0.0031308 ** (1 / 2.4) - 0.055, 0.0031308 * 12.92, 'encoding, at the knee', 1e-6)
})

test('render-srgb: encoding then decoding gives back the input', () => {
  for (let i = 0; i <= 4096; i++) {
    const x = i / 4096
    near(toLinear(toSrgb(x)), x, `linear ${x}`, 1e-12)
    near(toSrgb(toLinear(x)), x, `display ${x}`, 1e-12)
  }
})

test('render-srgb: the WGSL gives the CPU values, within one 8-bit step', async () => {
  // 0–1 in 4096 steps, then every 8-bit code.
  const inputs: number[] = []
  for (let i = 0; i <= 4096; i++) inputs.push(i / 4096)
  for (let k = 0; k <= 255; k++) inputs.push(k / 255)
  const n = inputs.length
  const g = await openFrame(1, 1)
  const module = g.device.createShaderModule({
    code: `${SRGB_WGSL}
@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&src)) { return; }
  let x = vec3f(src[i]);
  dst[i] = vec4f(toLinear(x).r, toSrgb(x).r, toSrgb(toLinear(x)).r, toLinear(toSrgb(x)).r);
}`,
  })
  const pipeline = g.device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  })
  const src = g.device.createBuffer({
    size: n * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  g.device.queue.writeBuffer(src, 0, new Float32Array(inputs))
  const dst = g.device.createBuffer({
    size: n * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })
  const encoder = g.device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(
    0,
    g.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: src } },
        { binding: 1, resource: { buffer: dst } },
      ],
    }),
  )
  pass.dispatchWorkgroups(Math.ceil(n / 64))
  pass.end()
  g.device.queue.submit([encoder.finish()])
  const out = new Float32Array((await readBuffer(g.device, dst)).buffer)

  const step = 1 / 255
  inputs.forEach((x, i) => {
    const [linear, display, back, again] = [0, 1, 2, 3].map((k) => out[i * 4 + k] ?? Number.NaN)
    const f = Math.fround(x)
    assert.ok(Math.abs((linear ?? 0) - toLinear(f)) <= step, `toLinear(${x}): ${linear}`)
    assert.ok(Math.abs((display ?? 0) - toSrgb(f)) <= step, `toSrgb(${x}): ${display}`)
    assert.ok(Math.abs((back ?? 0) - f) <= step, `toSrgb(toLinear(${x})): ${back}`)
    assert.ok(Math.abs((again ?? 0) - f) <= step, `toLinear(toSrgb(${x})): ${again}`)
  })
  // Every 8-bit code decoded and encoded again on the GPU is the same code.
  for (let k = 0; k <= 255; k++)
    assert.equal(Math.round((out[(4097 + k) * 4 + 2] ?? Number.NaN) * 255), k, `code ${k}`)
  g.done()
})
