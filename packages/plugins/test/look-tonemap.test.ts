// look-tonemap, on the CPU and headless on Dawn. Checked: PBR Neutral and AgX give their references'
// values; and the WGSL gives the CPU's values, within one 8-bit step once encoded to sRGB, on a
// sweep from deep shadow to 2^10 over white in every hue.
//
// The reference values: PBR Neutral worked by hand from the Khronos formula
// (github.com/KhronosGroup/ToneMapping, PBR_Neutral); AgX from three.js r186's AgXToneMapping
// (src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js), transcribed apart from
// the plugin and run in float64.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBuffer } from '@shaderera/core/gpu'
import { agx, type LinearRgb, pbrNeutral } from '../look-tonemap/src/looks/tonemap.ts'
import { TONEMAP_WGSL } from '../look-tonemap/src/looks/tonemap.wgsl.ts'
import { openFrame } from './frame.ts'

const near = (got: readonly number[], want: readonly number[], what: string, eps = 5e-5) =>
  assert.ok(
    got.every((v, i) => Math.abs(v - (want[i] ?? Number.NaN)) <= eps),
    `${what}: ${got.map((v) => v.toFixed(5))} is not ${want}`,
  )

test('look-tonemap: PBR Neutral gives the Khronos values', () => {
  // Grey below the shoulder loses the 0.04 offset and nothing else.
  near(pbrNeutral([0.5, 0.5, 0.5]), [0.46, 0.46, 0.46], 'mid grey')
  // Near black the offset is x - 6.25x²: 0.04 - 0.01.
  near(pbrNeutral([0.04, 0.04, 0.04]), [0.01, 0.01, 0.01], 'near black')
  near(pbrNeutral([0, 0, 0]), [0, 0, 0], 'black')
  // White: peak 0.96, new peak 1 - 0.24² / 0.44.
  near(pbrNeutral([1, 1, 1]), [0.869091, 0.869091, 0.869091], 'white')
  // (2, 0.5, 0.1): peak 1.96, new peak 1 - 0.24² / 1.44 = 0.96, then 1 - 1/1.15 of the way to it.
  near(pbrNeutral([2, 0.5, 0.1]), [0.96, 0.321136, 0.150772], 'an orange highlight')
})

test('look-tonemap: AgX gives the three.js values', () => {
  near(agx([0, 0, 0]), [0, 0, 0], 'black')
  // Middle grey sits at 10 of the 16.5 stops: contrast(0.606024) = 0.496655, to the 2.2.
  near(agx([0.18, 0.18, 0.18]), [0.21455, 0.2145, 0.2145], 'middle grey')
  near(agx([1, 1, 1]), [0.59023, 0.59014, 0.5901], 'white')
  near(agx([4, 4, 4]), [0.86102, 0.86091, 0.86084], 'two stops over white')
  near(agx([1, 0.2, 0.05]), [0.6551, 0.26522, 0.1374], 'orange')
  near(agx([0.05, 0.3, 2]), [0.20133, 0.41653, 0.83848], 'a bright blue')
  near(agx([16, 2, 0.5]), [1, 0.82802, 0.70477], 'a hot orange, towards white')
  // The top of the range: contrast(1) = 0.99858, to the 2.2; AgX never quite reaches white.
  near(agx([1e6, 1e6, 1e6]), [0.99698, 0.99688, 0.99678], 'far over white')
})

test('look-tonemap: the WGSL gives the CPU values, within one 8-bit step', async () => {
  // Twelve hues at five saturations, grey to full, from 2^-12 to 2^10 in half stops.
  const inputs: LinearRgb[] = []
  for (let ev = -12; ev <= 10; ev += 0.5)
    for (let h = 0; h < 12; h++)
      for (const s of [0, 0.25, 0.5, 0.75, 1]) {
        const a = (h / 12) * Math.PI * 2
        const hue = [0, 2.0944, 4.18879].map((o) => 1 - s * (0.5 - 0.5 * Math.cos(a - o)))
        inputs.push(hue.map((v) => v * 2 ** ev) as unknown as LinearRgb)
      }
  inputs.push([0, 0, 0], [0.08, 0.08, 0.08], [0.76, 0.2, 0.2], [100, 0, 0], [0, 0, 100])
  const n = inputs.length
  const g = await openFrame(1, 1)
  const module = g.device.createShaderModule({
    code: `${TONEMAP_WGSL}
@group(0) @binding(0) var<storage, read> src: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&src)) { return; }
  dst[2u * i] = vec4f(pbrNeutral(src[i].rgb), 0.0);
  dst[2u * i + 1u] = vec4f(agx(src[i].rgb), 0.0);
}`,
  })
  const pipeline = g.device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  })
  const src = g.device.createBuffer({
    size: n * 16,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  g.device.queue.writeBuffer(src, 0, new Float32Array(inputs.flatMap((c) => [...c, 0])))
  const dst = g.device.createBuffer({
    size: n * 32,
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

  // The 8-bit step the film writes: after the sRGB encoding, where the shadows are finest.
  const encode = (v: number) =>
    v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055
  inputs.forEach((c, i) => {
    // The CPU in float32's input, as the GPU read it.
    const f = c.map(Math.fround) as unknown as LinearRgb
    for (const [k, cpu] of [pbrNeutral(f), agx(f)].entries())
      for (let ch = 0; ch < 3; ch++) {
        const gpu = out[(2 * i + k) * 4 + ch] ?? Number.NaN
        const d = Math.abs(encode(gpu) - encode(cpu[ch] ?? 0)) * 255
        assert.ok(d <= 1, `${k ? 'agx' : 'pbrNeutral'}(${c}) channel ${ch}: ${gpu} vs ${cpu[ch]}`)
      }
  })
  g.done()
})
