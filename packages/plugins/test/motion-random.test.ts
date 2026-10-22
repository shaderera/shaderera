// motion-random, on the CPU and headless on Dawn. Checked: the hash gives the values the private
// copies in text-scramble, text-glyph-points and camera-shake gave (recorded before they were
// removed), and the stream mulberry32's; the stream repeats for a seed; the WGSL hash gives the
// CPU's 32 bits exactly, and its rnd the CPU's rnd rounded down to 24 bits; and the plugins that
// import it, laid out alone with what they require, give what they gave.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readBuffer } from '@shaderera/core/gpu'
import { hash, rnd, stream } from '../motion-random/src/motion/random.ts'
import { RANDOM_WGSL } from '../motion-random/src/motion/random.wgsl.ts'
import { openFrame } from './frame.ts'
import { layOut } from './lay-out.ts'

test('motion-random: the hash the plugins kept their own copies of', () => {
  const at = [0, 1, 2, 7, 42, 1000, 123456789, 4294967295]
  const was = [
    129708002, 2831084092, 2055130248, 2120684060, 1223963391, 2163870295, 4272394698, 3861530882,
  ]
  assert.deepEqual(at.map(hash), was)
  assert.equal(hash(-1), hash(4294967295), 'cut to 32 bits')
  assert.equal(rnd(42), 1223963391 / 4294967296)
  for (let v = 0; v < 10000; v++) {
    const r = rnd(v * 7919 + 13)
    assert.ok(r >= 0 && r < 1, `rnd(${v}) = ${r}`)
  }
})

test('motion-random: the stream is mulberry32, and repeats for a seed', () => {
  const next = stream(1)
  assert.deepEqual(
    [next(), next(), next(), next()].map((x) => x * 4294967296),
    [2693262067, 11749833, 2265367787, 4213581821],
  )
  const run = (seed: number) => {
    const s = stream(seed)
    return Array.from({ length: 1000 }, s)
  }
  assert.deepEqual(run(7), run(7))
  assert.notDeepEqual(run(7), run(8))
  const r = run(3)
  assert.ok(r.every((x) => x >= 0 && x < 1))
  const mean = r.reduce((s, x) => s + x, 0) / r.length
  assert.ok(Math.abs(mean - 0.5) < 0.05, `mean ${mean}`)
})

test('motion-random: the WGSL hash gives the CPU bits exactly', async () => {
  const inputs: number[] = [0, 1, 2, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]
  const next = stream(186)
  for (let i = 0; i < 4096; i++) inputs.push(Math.floor(next() * 4294967296))
  for (let i = 0; i < 1024; i++) inputs.push(i)
  const n = inputs.length
  const g = await openFrame(1, 1)
  const module = g.device.createShaderModule({
    code: `${RANDOM_WGSL}
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec2u>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&src)) { return; }
  dst[i] = vec2u(hash(src[i]), bitcast<u32>(rnd(src[i])));
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
  g.device.queue.writeBuffer(src, 0, new Uint32Array(inputs))
  const dst = g.device.createBuffer({
    size: n * 8,
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
  const bytes = await readBuffer(g.device, dst)
  const bits = new Uint32Array(bytes.buffer, bytes.byteOffset, n * 2)
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, n * 2)
  inputs.forEach((v, i) => {
    assert.equal(bits[i * 2], hash(v), `hash(${v})`)
    assert.equal(floats[i * 2 + 1], Math.floor(rnd(v) * 16777216) / 16777216, `rnd(${v})`)
  })
  g.done()
})

test('motion-random: the plugins built on it, laid out alone, give what they gave', async () => {
  const S = (await layOut('text-scramble')(
    'src/type/scramble.ts',
  )) as typeof import('../text-scramble/src/type/scramble.ts')
  // What text-scramble 0.1.0 gave, with its own copy of the hash.
  assert.equal(S.scramble('HELLO WORLD', 7, 0.5), '!E\\1O 7ORED')
  assert.equal(S.scramble('BEAT GRID 174.3', 120, 0.8), '5EAZ D+*4 &*61|')
  const K = (await layOut('camera-shake')(
    'src/motion/shake.ts',
  )) as typeof import('../camera-shake/src/motion/shake.ts')
  // What camera-shake 0.2.0 gave.
  assert.equal(K.noise1(3.7, 5), -0.1169386488700992)
  assert.equal(K.noise1(12.25), 0.2774692002458323)
  await layOut('text-glyph-points')('src/procedural/glyph-points.ts')
  await layOut('text-code-wall')('src/type/code-wall.ts')
})
