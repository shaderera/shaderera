// render-srgb: the same ramp of linear light, 0 to 1 across the frame, twice, from one shader that
// includes SRGB_WGSL: above, encoded with toSrgb, as a film writes it; below, written as it is,
// so the dark half crowds into black. A red marker sweeps the ramp and back over the loop, and its
// readout is the CPU's toSrgb and toLinear at the marker: the light, its display value and its
// 8-bit code, and that code decoded again.

import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'
import { toLinear, toSrgb } from '../../previews/src/render/srgb.ts'
import { SRGB_WGSL } from '../../previews/src/render/srgb.wgsl.ts'

/** The two bands, in px: encoded above, not encoded below. */
const BANDS = { x: L, w: R - L, top: 200, h: 220, gap: 90 }

const SHADER = /* wgsl */ `${SRGB_WGSL}
struct Bands { a: vec4f }  // x, w, top, h (px)
@group(0) @binding(0) var<uniform> u: Bands;
const GAP = ${BANDS.gap}.0;

@vertex fn fullVs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn bandsFs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let light = vec3f(clamp((pos.x - u.a.x) / u.a.y, 0.0, 1.0));
  let y = pos.y - u.a.z;
  if (pos.x < u.a.x || pos.x >= u.a.x + u.a.y) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  if (y >= 0.0 && y < u.a.w) { return vec4f(toSrgb(light), 1.0); }
  if (y >= u.a.w + GAP && y < 2.0 * u.a.w + GAP) { return vec4f(light, 1.0); }
  return vec4f(0.0, 0.0, 0.0, 1.0);
}
`

const renderSrgb: OpenPreview = async (host) => {
  const device = host.gpu
  if (!device) throw new Error('The render-srgb preview needs WebGPU (host.gpu)')
  const { width, height, duration } = host.manifest
  const module = device.createShaderModule({ code: SHADER })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'fullVs' },
    fragment: { module, entryPoint: 'bandsFs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  })
  const uniforms = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(uniforms, 0, new Float32Array([BANDS.x, BANDS.w, BANDS.top, BANDS.h]))
  const out = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage:
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC,
  })
  // The bands never change: drawn once.
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      { view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
    ],
  })
  pass.setPipeline(pipeline)
  pass.setBindGroup(
    0,
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniforms } }],
    }),
  )
  pass.draw(3)
  pass.end()
  device.queue.submit([encoder.finish()])

  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const top: Word[] = [{ from: 0, to: duration, text: 'TO SRGB' }]
  const bottom: Word[] = [{ from: 0, to: duration, text: 'LINEAR LIGHT' }]
  const notes: Word[] = [
    { from: 0, to: duration, text: 'above encoded, below the same light as it is' },
  ]
  /** The light under the marker at t: 0 to 1 and back, once a loop. */
  const lightAt = (t: number) => 0.5 - 0.5 * Math.cos((t / duration) * Math.PI * 2)
  const below = BANDS.top + BANDS.h + BANDS.gap

  return {
    async render(t, o) {
      const light = lightAt(t)
      const display = toSrgb(light)
      const code = Math.round(display * 255)
      ctx.clearRect(0, 0, width, height)
      house.index()
      house.words(top, bottom, t, o.frame)
      house.notes(notes, t, o.frame)

      ctx.font = `14px "${FONT.mono}"`
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = '#9a9a9a'
      ctx.textAlign = 'left'
      ctx.fillText('ENCODED: toSrgb(light)', BANDS.x, BANDS.top - 14)
      ctx.fillText('NOT ENCODED: light', BANDS.x, below - 14)
      for (const v of [0, 0.18, 0.5, 1]) {
        const x = BANDS.x + v * BANDS.w
        ctx.textAlign = v === 0 ? 'left' : v === 1 ? 'right' : 'center'
        ctx.fillText(v.toFixed(2), x, below + BANDS.h + 24)
      }

      const x = BANDS.x + light * BANDS.w
      ctx.strokeStyle = RED
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(x, BANDS.top - 4)
      ctx.lineTo(x, below + BANDS.h + 4)
      ctx.stroke()
      ctx.fillStyle = RED
      ctx.textAlign = light < 0.5 ? 'left' : 'right'
      const pad = light < 0.5 ? 10 : -10
      ctx.fillText(`${display.toFixed(3)}  CODE ${code}`, x + pad, BANDS.top + BANDS.h - 12)
      ctx.fillText(`${light.toFixed(3)}`, x + pad, below + BANDS.h - 12)
      house.hud(
        t,
        o.frame,
        `LIGHT ${light.toFixed(3)} → CODE ${code} → ${toLinear(code / 255).toFixed(3)}`,
        'IEC 61966-2-1',
      )
      return [
        { color: out, alpha: 'opaque' },
        { color: canvas, name: 'house' },
      ]
    },
    status(t) {
      return `light ${lightAt(t).toFixed(3)}`
    },
    inspect(t) {
      const light = lightAt(t)
      return { id: 'srgb', light, display: toSrgb(light) }
    },
  }
}

export default renderSrgb
