// motion-random: two grids of cells, each cell's grey its rnd, left from a shader that includes
// RANDOM_WGSL, right from the CPU's rnd: the same picture, cell for cell. The grids take a new key
// twice a second. A red marker walks the cells, and its readout is the CPU's hash of that cell.
// Below, dots placed once in open by a seeded stream drift across the frame, wrapping, one width
// a loop.

import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { hash, rnd, stream } from '../../previews/src/motion/random.ts'
import { RANDOM_WGSL } from '../../previews/src/motion/random.wgsl.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const COLS = 16
const ROWS = 12
const CELL = 30
const GRID = { top: 190, gap: 24 }
const LEFT = L
const RIGHT = L + COLS * CELL + GRID.gap
const DOTS = { count: 360, top: 625, h: 115 }
/** New keys a loop: twice a second over 6 s, so the last key leads back to the first. */
const KEYS = 12

/** The integer a cell hashes: its index, mixed with the key. */
const cellValue = (i: number, key: number) => i + key * 7919

const SHADER = /* wgsl */ `${RANDOM_WGSL}
struct U { a: vec4f }  // left, top, cell, key
@group(0) @binding(0) var<uniform> u: U;

@vertex fn fullVs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn gridFs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let q = (pos.xy - u.a.xy) / u.a.z;
  if (q.x < 0.0 || q.y < 0.0 || q.x >= ${COLS}.0 || q.y >= ${ROWS}.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  if (fract(q.x) * u.a.z < 2.0 || fract(q.y) * u.a.z < 2.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let i = u32(q.y) * ${COLS}u + u32(q.x);
  return vec4f(vec3f(rnd(i + u32(u.a.w) * 7919u)), 1.0);
}
`

const motionRandom: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`motion-random has no state "${stateId}"`)
  const device = host.gpu
  if (!device) throw new Error('The motion-random preview needs WebGPU (host.gpu)')
  const { width, height, duration } = host.manifest
  const fps = Number(host.manifest.fps)
  const module = device.createShaderModule({ code: SHADER })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'fullVs' },
    fragment: { module, entryPoint: 'gridFs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  })
  const uniforms = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniforms } }],
  })
  const out = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC,
  })

  // The dots: placed once, here, by the stream.
  const next = stream(186)
  const dots = Array.from({ length: DOTS.count }, () => ({ x: next(), y: next(), r: next() }))

  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const top: Word[] = [{ from: 0, to: duration, text: 'HASH' }]
  const bottom: Word[] = [{ from: 0, to: duration, text: 'STREAM' }]
  const notes: Word[] = [
    { from: 0, to: duration / 2, text: 'left on the GPU, right on the CPU: the same bits' },
    { from: duration / 2, to: duration, text: 'below, a run of numbers made once, from a seed' },
  ]
  const keyAt = (t: number) => Math.floor((t / duration) * KEYS) % KEYS
  const cellAt = (frame: number) => frame % (COLS * ROWS)

  return {
    async render(t, o) {
      const key = keyAt(t)
      device.queue.writeBuffer(uniforms, 0, new Float32Array([LEFT, GRID.top, CELL, key]))
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
        ],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bind)
      pass.draw(3)
      pass.end()
      device.queue.submit([encoder.finish()])

      ctx.clearRect(0, 0, width, height)
      house.index()
      // The CPU's grid, beside the shader's.
      for (let i = 0; i < COLS * ROWS; i++) {
        const g = Math.round(rnd(cellValue(i, key)) * 255)
        ctx.fillStyle = `rgb(${g},${g},${g})`
        ctx.fillRect(
          RIGHT + (i % COLS) * CELL + 2,
          GRID.top + Math.floor(i / COLS) * CELL + 2,
          CELL - 2,
          CELL - 2,
        )
      }
      house.words(top, bottom, t, o.frame)
      house.notes(notes, t, o.frame)

      ctx.font = `14px "${FONT.mono}"`
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = '#9a9a9a'
      ctx.textAlign = 'left'
      ctx.fillText('WGSL: rnd(i)', LEFT, GRID.top - 14)
      ctx.fillText('CPU: rnd(i)', RIGHT, GRID.top - 14)
      ctx.fillText('stream(186), 360 dots', L, DOTS.top - 14)

      // The marker walks a cell a frame, on both grids.
      const i = cellAt(o.frame)
      const cx = (i % COLS) * CELL + 1
      const cy = GRID.top + Math.floor(i / COLS) * CELL + 1
      ctx.strokeStyle = RED
      ctx.lineWidth = 2
      for (const x of [LEFT, RIGHT]) ctx.strokeRect(x + cx, cy, CELL, CELL)
      const v = cellValue(i, key)
      ctx.fillStyle = RED
      ctx.fillText(
        `hash(${v}) = 0x${hash(v).toString(16).padStart(8, '0')}`,
        LEFT,
        GRID.top + ROWS * CELL + 26,
      )

      // The dots drift one width a loop, so the last frame leads back to the first.
      const drift = (o.frame / (duration * fps)) % 1
      ctx.fillStyle = '#fff'
      for (const d of dots) {
        const x = L + ((d.x + drift) % 1) * (R - L)
        ctx.beginPath()
        ctx.arc(x, DOTS.top + d.y * DOTS.h, 1.5 + d.r * 2.5, 0, Math.PI * 2)
        ctx.fill()
      }

      house.hud(t, o.frame, `KEY ${key} · CELL ${i}`, 'PCG · MULBERRY32')
      return [
        { color: out, alpha: 'opaque' },
        { color: canvas, name: 'house' },
      ]
    },
    status(t) {
      return `key ${keyAt(t)}`
    },
    inspect(t) {
      const frame = Math.round(t * fps)
      const i = cellAt(frame)
      const v = cellValue(i, keyAt(t))
      return { id: 'random', cell: i, hash: hash(v), rnd: rnd(v) }
    },
  }
}

export default motionRandom
