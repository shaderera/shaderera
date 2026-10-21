// render-canvas-texture: a plain Canvas2D picture, a few shapes turning once a loop, drawn on the
// left as Canvas2D shows it, and on the right uploaded with upload() and read by a WGSL pass with
// textureLoad, pixel for pixel. A red marker circles the picture on both sides, and its readout
// is the four bytes under it.

import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import {
  CANVAS_TEXTURE_FORMAT,
  createCanvasTexture,
} from '../../previews/src/render/canvas-texture.ts'

/** The two panels, in px: the canvas on the left, the uploaded texture on the right. */
const SIZE = 460
const TOP = 210
const LEFT = L
const RIGHT = R - SIZE

const SHADER = /* wgsl */ `
struct U { a: vec4f }  // x, y, size
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var src: texture_2d<f32>;

@vertex fn fullVs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn panelFs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let q = pos.xy - u.a.xy;
  if (q.x < 0.0 || q.y < 0.0 || q.x >= u.a.z || q.y >= u.a.z) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  return textureLoad(src, vec2u(q), 0);
}
`

const renderCanvasTexture: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`render-canvas-texture has no state "${stateId}"`)
  const device = host.gpu
  if (!device) throw new Error('The render-canvas-texture preview needs WebGPU (host.gpu)')
  const { width, height, duration } = host.manifest
  const module = device.createShaderModule({ code: SHADER })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'fullVs' },
    fragment: { module, entryPoint: 'panelFs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  })
  const uniforms = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(uniforms, 0, new Float32Array([RIGHT, TOP, SIZE, 0]))
  const out = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC,
  })
  const canvases = createCanvasTexture(host)
  const groups = new WeakMap<GPUTexture, GPUBindGroup>()
  const groupOf = (texture: GPUTexture) => {
    let g = groups.get(texture)
    if (!g) {
      g = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: texture.createView() },
        ],
      })
      groups.set(texture, g)
    }
    return g
  }

  // The stand-in picture: shapes turning once a loop, so the last frame leads back to the first.
  const picture = host.io.canvas(SIZE, SIZE)
  const p = picture.getContext('2d') as OffscreenCanvasRenderingContext2D
  const draw = (turn: number) => {
    p.fillStyle = '#1b1b1b'
    p.fillRect(0, 0, SIZE, SIZE)
    const c = SIZE / 2
    for (let k = 0; k < 6; k++) {
      const a = turn * Math.PI * 2 + (k * Math.PI) / 3
      const r = 120 + 40 * Math.sin(turn * Math.PI * 2 * 2 + k)
      p.fillStyle = k % 2 ? '#e8e8e8' : '#7d7d7d'
      p.beginPath()
      p.arc(c + Math.cos(a) * r, c + Math.sin(a) * r, 34 + 10 * k, 0, Math.PI * 2)
      p.fill()
    }
    p.strokeStyle = '#fff'
    p.lineWidth = 6
    p.strokeRect(c - 80, c - 80, 160, 160)
  }
  /** The marker, in the picture's pixels: a circle once a loop. */
  const markerAt = (turn: number): [number, number] => {
    const a = -turn * Math.PI * 2
    return [Math.round(SIZE / 2 + Math.cos(a) * 150), Math.round(SIZE / 2 + Math.sin(a) * 150)]
  }

  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const top: Word[] = [{ from: 0, to: duration, text: 'CANVAS2D' }]
  const bottom: Word[] = [{ from: 0, to: duration, text: 'GPU TEXTURE' }]
  const notes: Word[] = [
    { from: 0, to: duration, text: 'left as drawn, right uploaded and read in WGSL' },
  ]

  return {
    async render(t, o) {
      const turn = t / duration
      draw(turn)
      const texture = canvases.upload(picture)
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
        ],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, groupOf(texture))
      pass.draw(3)
      pass.end()
      device.queue.submit([encoder.finish()])

      ctx.clearRect(0, 0, width, height)
      house.index()
      ctx.drawImage(picture as unknown as CanvasImageSource, LEFT, TOP)
      house.words(top, bottom, t, o.frame)
      house.notes(notes, t, o.frame)

      ctx.font = `14px "${FONT.mono}"`
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = '#9a9a9a'
      ctx.textAlign = 'left'
      ctx.fillText('CANVAS2D: drawImage', LEFT, TOP - 14)
      ctx.fillText(`WGSL: textureLoad, ${CANVAS_TEXTURE_FORMAT}`, RIGHT, TOP - 14)

      const [mx, my] = markerAt(turn)
      const px = p.getImageData(mx, my, 1, 1).data
      ctx.strokeStyle = RED
      ctx.lineWidth = 2
      for (const x of [LEFT, RIGHT]) ctx.strokeRect(x + mx - 8, TOP + my - 8, 16, 16)
      ctx.fillStyle = RED
      ctx.fillText(`(${mx}, ${my})  RGBA ${[...px].join(' ')}`, LEFT, TOP + SIZE + 28)

      house.hud(t, o.frame, `${SIZE}×${SIZE} · ONE TEXTURE`, 'getImageData → writeTexture')
      return [
        { color: out, alpha: 'opaque' },
        { color: canvas, name: 'house' },
      ]
    },
    status(t) {
      const [x, y] = markerAt(t / duration)
      return `pixel ${x}, ${y}`
    },
    inspect(t) {
      const [x, y] = markerAt(t / duration)
      return { id: 'canvas-texture', marker: [x, y], format: CANVAS_TEXTURE_FORMAT }
    },
  }
}

export default renderCanvasTexture
