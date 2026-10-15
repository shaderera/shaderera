// look-tonemap: a plain exposure chart in linear light, eight bands (seven hues and white), each
// from 6 stops under middle grey to 6 over across the frame, through the plugin's WGSL in the
// preview's own output shader, which encodes it to sRGB as a film would. The exposure breathes
// 1.5 stops either way over the loop. In the 'all' state the curve cuts at 3 s: PBR Neutral, then
// AgX; a state holds one. The curve is the big word top left; a red tick marks where the input
// reaches 1.0, where an untone-mapped frame would clip.

import { createHouse, L, R, RED, type Word } from '../../previews/src/house.ts'
import { TONEMAP_WGSL } from '../../previews/src/looks/tonemap.wgsl.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

type Segment = { id: string; word: string; note: string; curve: 0 | 1 }

/** The curves in order, half the loop each; the first follows the last. */
const SEGMENTS: Segment[] = [
  {
    id: 'neutral',
    word: 'PBR NEUTRAL',
    note: 'colours kept, highlights rolled off to white',
    curve: 0,
  },
  { id: 'agx', word: 'AGX', note: 'a filmic curve: brights fade towards white', curve: 1 },
]

/** The chart: its box in px and its range in stops around middle grey. */
const CHART = { x: L, y: 170, w: R - L, h: 560, ev: 6 }

const SHADER = /* wgsl */ `${TONEMAP_WGSL}
struct Chart { box: vec4f, a: vec4f }  // x, y, w, h (px); stops either side, exposure, curve, 0
@group(0) @binding(0) var<uniform> u: Chart;

@vertex fn fullVs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn toSrgb(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}

@fragment fn chartFs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let q = (pos.xy - u.box.xy) / u.box.zw;
  if (any(q < vec2f(0.0)) || any(q >= vec2f(1.0))) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  var hues = array<vec3f, 8>(
    vec3f(1.0, 0.03, 0.02), vec3f(1.0, 0.35, 0.02), vec3f(1.0, 0.85, 0.03), vec3f(0.08, 1.0, 0.05),
    vec3f(0.02, 0.75, 1.0), vec3f(0.06, 0.12, 1.0), vec3f(0.85, 0.04, 1.0), vec3f(1.0, 1.0, 1.0),
  );
  let hue = hues[min(u32(q.y * 8.0), 7u)];
  let light = hue * 0.18 * exp2(mix(-u.a.x, u.a.x, q.x) + u.a.y);
  let mapped = select(pbrNeutral(light), agx(light), u.a.z > 0.5);
  return vec4f(toSrgb(mapped), 1.0);
}
`

const lookTonemap: OpenPreview = async (host, stateId) => {
  const segments = stateId === 'all' ? SEGMENTS : SEGMENTS.filter((s) => s.id === stateId)
  if (segments.length === 0) throw new Error(`look-tonemap has no state "${stateId}"`)
  const device = host.gpu
  if (!device) throw new Error('The look-tonemap preview needs WebGPU (host.gpu)')
  const { width, height, duration } = host.manifest
  const step = duration / segments.length
  const module = device.createShaderModule({ code: SHADER })
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'fullVs' },
    fragment: { module, entryPoint: 'chartFs', targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  })
  const uniforms = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const group = device.createBindGroup({
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
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const words: Word[] = segments.map((s, i) => ({
    from: i * step,
    to: (i + 1) * step,
    text: s.word,
  }))
  const notes: Word[] = segments.map((s, i) => ({ ...(words[i] as Word), text: s.note }))
  const chart: Word[] = [{ from: 0, to: duration, text: 'LINEAR LIGHT' }]
  const segmentAt = (t: number) => {
    const n = Math.floor(t / step) % segments.length
    return { n, segment: segments[n] as Segment }
  }
  /** The exposure at t in stops, once round a loop. */
  const exposureAt = (t: number) => 1.5 * Math.sin((t / duration) * Math.PI * 2)

  return {
    async render(t, o) {
      const { segment } = segmentAt(t)
      const exposure = exposureAt(t)
      device.queue.writeBuffer(
        uniforms,
        0,
        new Float32Array([
          CHART.x,
          CHART.y,
          CHART.w,
          CHART.h,
          CHART.ev,
          exposure,
          segment.curve,
          0,
        ]),
      )
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
        ],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.draw(3)
      pass.end()
      device.queue.submit([encoder.finish()])

      ctx.clearRect(0, 0, width, height)
      house.index()
      house.words(words, chart, t, o.frame)
      house.notes(notes, t, o.frame)
      // The stops under the chart, and the red tick where the input reaches 1.0 (white's own band).
      const xOf = (ev: number) => CHART.x + ((ev + CHART.ev) / (2 * CHART.ev)) * CHART.w
      ctx.font = `14px "${FONT.mono}"`
      ctx.fillStyle = '#9a9a9a'
      ctx.textBaseline = 'alphabetic'
      for (const ev of [-6, -3, 0, 3, 6]) {
        ctx.textAlign = ev === -6 ? 'left' : ev === 6 ? 'right' : 'center'
        ctx.fillText(ev === 0 ? '0.18' : `${ev > 0 ? '+' : '−'}${Math.abs(ev)} EV`, xOf(ev), 756)
      }
      const white = xOf(Math.log2(1 / 0.18) - exposure)
      ctx.strokeStyle = RED
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(white, CHART.y - 18)
      ctx.lineTo(white, CHART.y + CHART.h + 4)
      ctx.stroke()
      ctx.fillStyle = RED
      ctx.textAlign = 'center'
      ctx.fillText('1.0', white, CHART.y - 26)
      house.hud(
        t,
        o.frame,
        `EXPOSURE ${exposure >= 0 ? '+' : '−'}${Math.abs(exposure).toFixed(2)} EV`,
        'OUT: LINEAR, ENCODED TO SRGB',
      )
      return [
        { color: out, alpha: 'opaque' },
        { color: canvas, name: 'house' },
      ]
    },
    status(t) {
      const { n, segment } = segmentAt(t)
      if (segments.length === 1) return segment.id
      return `${String(n + 1).padStart(2, '0')}/${String(segments.length).padStart(2, '0')}  ${segment.id}`
    },
    inspect(t) {
      const { segment } = segmentAt(t)
      return { id: 'tonemap', curve: segment.id, exposure: exposureAt(t) }
    },
  }
}

export default lookTonemap
