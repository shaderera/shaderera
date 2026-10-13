// text-glyph-outlines: one word from a font file through the item's three outputs. Outlines: the
// flattened contours, every point, and the font's own quadratics (on-curve squares, red control
// points and their handles), the tolerance sweeping from coarse to fine so the polylines
// refine. Fill: the triangles, holes cut, swept in, each letter riding its own glyph range.
// Solid: the closed extruded mesh in WebGPU, lit, wired, turning, its letters parting on their
// ranges and closing again. In the 'all' state the word goes through all three and flattens back
// into its outline, so the loop has no seam; a state holds one output for the whole loop.

import type { Layer } from '@shaderera/core'
import { createHouse, iridescent, type Word } from '../../previews/src/house.ts'
import type { OpenPreview } from '../../previews/src/preview.ts'
import {
  extrude,
  type GlyphOutline,
  glyphOutlines,
  loadFont,
  type Outlines,
  triangulate,
} from '../../previews/src/type/outlines.ts'

const WORD = 'Shape'
const FONT_FILE = 'assets/fonts/IBMPlexSans-Medium.ttf'
const DEPTH = 0.32
/** The middle of the picture above the caption band. */
const CX = 540
const CY = 456
const FOV = (30 * Math.PI) / 180
const DISTANCE = 5.85
/** Pixels per em of the front plane: the 2D views and the solid's front face agree. */
const S = 540 / (DISTANCE * Math.tan(FOV / 2))
const RED = '#ff3b1f'
/** Per phase, the corner words and the note: the phase's time is shared out among them. */
const WORDS: Record<Phase, [string, string, string][]> = {
  outlines: [
    ['OUTLINES', 'QUADRATICS', "the font's own curves, scaled and placed"],
    ['POINTS', 'TOLERANCE', 'no point strays past the tolerance'],
  ],
  fill: [
    ['FILL', 'TRIANGLES', 'earcut, counter-clockwise from +z'],
    ['HOLES', 'CUT', 'found by winding and containment'],
  ],
  solid: [
    ['EXTRUDED', 'MESH', 'closed: every edge shared by two'],
    ['LETTER BY', 'LETTER', 'one draw range per glyph'],
  ],
}
const MAX_GLYPHS = 16

type Phase = 'outlines' | 'fill' | 'solid'
type Span = { phase: Phase; from: number; to: number }
const SPANS: Record<string, Span[]> = {
  all: [
    { phase: 'outlines', from: 0, to: 1.6 },
    { phase: 'fill', from: 1.6, to: 3 },
    { phase: 'solid', from: 3, to: 6 },
  ],
  outlines: [{ phase: 'outlines', from: 0, to: 6 }],
  fill: [{ phase: 'fill', from: 0, to: 6 }],
  solid: [{ phase: 'solid', from: 0, to: 6 }],
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const ease = (x: number) => {
  const c = clamp01(x)
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2
}
const smooth = (x: number) => {
  const c = clamp01(x)
  return c * c * (3 - 2 * c)
}
const hash = (v: number) => {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0
  return ((w >>> 22) ^ w) >>> 0
}
const rnd = (v: number) => hash(v) / 4294967296

// Column-major 4×4 matrices, WebGPU clip space (z in [0, 1]).
type M = Float32Array
const mul = (a: M, b: M): M => {
  const o = new Float32Array(16)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] as number) * (b[c * 4 + k] as number)
      o[c * 4 + r] = s
    }
  return o
}
const perspective = (fov: number, aspect: number, near: number, far: number, shiftY: number): M => {
  const f = 1 / Math.tan(fov / 2)
  // prettier-ignore
  return new Float32Array([
    f / aspect,
    0,
    0,
    0,
    0,
    f,
    0,
    0,
    0,
    shiftY,
    far / (near - far),
    -1,
    0,
    0,
    (far * near) / (near - far),
    0,
  ])
}
const translate = (x: number, y: number, z: number): M =>
  new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1])
const rotY = (a: number): M => {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1])
}
const rotX = (a: number): M => {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1])
}

const SOLID_WGSL = /* wgsl */ `
struct U {
  viewProj: mat4x4f,
  model: mat4x4f,
  params: vec4f,                 // x depth scale, y fade, z wire alpha, w kick
  glyph: array<vec4f, ${MAX_GLYPHS}>,   // xyz offset, w spin about the glyph's own vertical axis
  centre: array<vec4f, ${MAX_GLYPHS}>,  // the glyph's centre (x, y, z)
}
@group(0) @binding(0) var<uniform> u: U;

struct In { @location(0) pos: vec3f, @location(1) normal: vec3f, @location(2) glyph: f32 }
struct V {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) front: f32,
}

fn place(i: In) -> V {
  let g = u32(i.glyph + 0.5);
  let c = u.centre[g].xyz;
  let a = u.glyph[g].w;
  let ca = cos(a);
  let sa = sin(a);
  var p = vec3f(i.pos.xy, i.pos.z * u.params.x) - c;
  p = vec3f(p.x * ca + p.z * sa, p.y, -p.x * sa + p.z * ca) + c + u.glyph[g].xyz;
  let n = vec3f(i.normal.x * ca + i.normal.z * sa, i.normal.y, -i.normal.x * sa + i.normal.z * ca);
  let w = u.model * vec4f(p, 1.0);
  var o: V;
  o.clip = u.viewProj * w;
  o.world = w.xyz;
  o.normal = (u.model * vec4f(n, 0.0)).xyz;
  o.front = i.normal.z;
  return o;
}

@vertex fn vs(i: In) -> V { return place(i); }

// The wire sits a hair in front of the faces it outlines.
@vertex fn vsWire(i: In) -> V {
  var o = place(i);
  o.clip.z -= 0.0015 * o.clip.w;
  return o;
}

@fragment fn fs(v: V, @builtin(front_facing) facing: bool) -> @location(0) vec4f {
  var n = normalize(v.normal);
  if (!facing) { n = -n; }
  let eye = vec3f(0.0, 0.0, ${DISTANCE.toFixed(2)});
  let view = normalize(eye - v.world);
  let key = normalize(vec3f(-0.45, 0.65, 0.7));
  let back = normalize(vec3f(0.8, -0.1, -0.6));
  let dif = max(dot(n, key), 0.0);
  let spec = pow(max(dot(reflect(-key, n), view), 0.0), 48.0);
  let rim = pow(max(dot(n, back), 0.0), 1.5);
  let fres = pow(1.0 - max(dot(n, view), 0.0), 3.0);
  let cap = abs(v.front) > 0.5;
  let base = select(vec3f(0.42), vec3f(0.94), cap);
  var col = base * (0.1 + 0.95 * dif)
    + vec3f(1.0) * spec * 0.9
    + mix(vec3f(1.0, 0.72, 0.6), vec3f(0.72, 0.62, 1.0), 0.5 + 0.5 * n.y) * rim * (0.9 + 1.2 * u.params.w)
    + vec3f(0.5) * fres * 0.4;
  col = col / (1.0 + col * 0.3);
  return vec4f(col * u.params.y, 1.0);
}

@fragment fn fsWire(v: V) -> @location(0) vec4f {
  return vec4f(vec3f(1.0) * u.params.z * u.params.y, 1.0);
}
`

const textGlyphOutlines: OpenPreview = async (host, stateId) => {
  const spans = SPANS[stateId]
  if (!spans) throw new Error(`text-glyph-outlines has no state "${stateId}"`)
  const { width, height } = host.manifest
  const font = await loadFont(host, FONT_FILE)
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const under = host.io.canvas(width, height)
  const uctx = under.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)
  const behind = createHouse(host, uctx)
  const words = (k: 0 | 1 | 2): Word[] =>
    spans.flatMap((span) => {
      const list = WORDS[span.phase]
      const step = (span.to - span.from) / list.length
      return list.map((w, i) => ({
        from: span.from + i * step,
        to: span.from + (i + 1) * step,
        text: w[k],
      }))
    })
  const TOPS = words(0)
  const BOTTOMS = words(1)
  const NOTES = words(2)

  // The word at its finest, centred on the origin: the fill, the solid and the 2D frame.
  const fine = glyphOutlines(font, WORD, { tolerance: 0.0008 })
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const g of fine.glyphs) {
    x0 = Math.min(x0, g.bounds[0])
    y0 = Math.min(y0, g.bounds[1])
    x1 = Math.max(x1, g.bounds[2])
    y1 = Math.max(y1, g.bounds[3])
  }
  const ox = (x0 + x1) / 2
  const oy = (y0 + y1) / 2
  const glyphCount = Math.min(MAX_GLYPHS, fine.glyphs.length)
  const centres = fine.glyphs.map((g) => [
    (g.bounds[0] + g.bounds[2]) / 2 - ox,
    (g.bounds[1] + g.bounds[3]) / 2 - oy,
  ])
  const sx = (x: number) => CX + (x - ox) * S
  const sy = (y: number) => CY - (y - oy) * S

  // Outlines at a few tolerances, made once: the sweep picks the nearest.
  const TOLERANCES = Array.from({ length: 40 }, (_, i) => 0.06 * (0.0008 / 0.06) ** (i / 39))
  const outlines = TOLERANCES.map((tolerance) => glyphOutlines(font, WORD, { tolerance }))
  const fills = outlines.map((o) => triangulate(o))

  // The solid, with each vertex's glyph, and the edges of its caps for the wire.
  const solid = extrude(fine, { depth: DEPTH })
  const vertexCount = solid.positions.length / 3
  const glyphOf = new Float32Array(vertexCount)
  for (const [g, range] of solid.glyphs.entries())
    for (let k = range.start; k < range.start + range.count; k++)
      glyphOf[solid.indices[k] as number] = g
  const vertices = new Float32Array(vertexCount * 7)
  for (let v = 0; v < vertexCount; v++) {
    vertices.set(
      [
        (solid.positions[v * 3] as number) - ox,
        (solid.positions[v * 3 + 1] as number) - oy,
        solid.positions[v * 3 + 2] as number,
        solid.normals[v * 3] as number,
        solid.normals[v * 3 + 1] as number,
        solid.normals[v * 3 + 2] as number,
        glyphOf[v] as number,
      ],
      v * 7,
    )
  }
  const capFill = triangulate(fine)
  const N = fine.points.length / 2
  const edgeSet = new Set<string>()
  const edges: number[] = []
  for (let k = 0; k < capFill.indices.length; k += 3)
    for (const [a, b] of [
      [capFill.indices[k], capFill.indices[k + 1]],
      [capFill.indices[k + 1], capFill.indices[k + 2]],
      [capFill.indices[k + 2], capFill.indices[k]],
    ] as [number, number][]) {
      const key = a < b ? `${a},${b}` : `${b},${a}`
      if (edgeSet.has(key)) continue
      edgeSet.add(key)
      edges.push(a, b, a + N, b + N)
    }

  const device = host.gpu
  const gpu = device
    ? (() => {
        const format: GPUTextureFormat = 'rgba8unorm'
        const target = device.createTexture({
          size: [width, height],
          format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        })
        const msaa = device.createTexture({
          size: [width, height],
          format,
          sampleCount: 4,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })
        const depth = device.createTexture({
          size: [width, height],
          format: 'depth24plus',
          sampleCount: 4,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })
        const buffer = (data: Float32Array | Uint32Array, usage: number) => {
          const b = device.createBuffer({
            size: Math.ceil(data.byteLength / 4) * 4,
            usage: usage | GPUBufferUsage.COPY_DST,
          })
          device.queue.writeBuffer(b, 0, data)
          return b
        }
        const vbuf = buffer(vertices, GPUBufferUsage.VERTEX)
        const ibuf = buffer(solid.indices, GPUBufferUsage.INDEX)
        const ebuf = buffer(new Uint32Array(edges), GPUBufferUsage.INDEX)
        const ubuf = device.createBuffer({
          size: 64 * 2 + 16 + 16 * MAX_GLYPHS * 2,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        const module = device.createShaderModule({ code: SOLID_WGSL })
        const layout = device.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
              buffer: { type: 'uniform' },
            },
          ],
        })
        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] })
        const vertex = (entryPoint: string): GPUVertexState => ({
          module,
          entryPoint,
          buffers: [
            {
              arrayStride: 28,
              attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x3' },
                { shaderLocation: 2, offset: 24, format: 'float32' },
              ],
            },
          ],
        })
        const faces = device.createRenderPipeline({
          layout: pipelineLayout,
          vertex: vertex('vs'),
          fragment: { module, entryPoint: 'fs', targets: [{ format }] },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
          multisample: { count: 4 },
        })
        const wire = device.createRenderPipeline({
          layout: pipelineLayout,
          vertex: vertex('vsWire'),
          fragment: {
            module,
            entryPoint: 'fsWire',
            targets: [
              {
                format,
                blend: {
                  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                },
              },
            ],
          },
          primitive: { topology: 'line-list' },
          depthStencil: {
            format: 'depth24plus',
            depthWriteEnabled: false,
            depthCompare: 'less-equal',
          },
          multisample: { count: 4 },
        })
        const group = device.createBindGroup({
          layout,
          entries: [{ binding: 0, resource: { buffer: ubuf } }],
        })
        return { target, msaa, depth, vbuf, ibuf, ebuf, ubuf, faces, wire, group }
      })()
    : undefined

  // Where t is: the phase, how far through it, and the solid's pose.
  const state = (t: number) => {
    const span = spans.find((s) => t >= s.from && t < s.to) ?? (spans[spans.length - 1] as Span)
    const u = (t - span.from) / (span.to - span.from)
    const all = spans.length > 1
    // How fine the polylines are (0 the coarsest tolerance, 1 the finest): coarse to fine through
    // the outlines, and breathing through the fill in its own state.
    let f = 1
    if (span.phase === 'outlines') f = all ? ease(u / 0.85) : 0.5 - 0.5 * Math.cos(u * Math.PI * 2)
    if (span.phase === 'fill' && !all) f = 0.25 + 0.75 * (0.5 + 0.5 * Math.cos(u * Math.PI * 2))
    const tol = Math.round(f * (TOLERANCES.length - 1))
    // The solid: in 'all' it grows from the fill, turns once and flattens into the outline.
    let depth = 1
    let yaw = 0
    let pitch = 0
    let part = 0
    let fade = 1
    if (span.phase === 'solid') {
      if (all) {
        depth = ease((t - 3) / 0.45) * (1 - ease((t - 5.45) / 0.35))
        const turn = ease((t - 3.25) / 2.25)
        yaw = turn * Math.PI * 2
        pitch = Math.sin(turn * Math.PI) * 0.42
        part = Math.sin(clamp01((t - 3.5) / 1.8) * Math.PI) ** 2
        fade = 1 - smooth((t - 5.7) / 0.3)
      } else {
        yaw = u * Math.PI * 2
        pitch = 0.32 * Math.sin(u * Math.PI * 4)
        part = Math.sin(u * Math.PI * 2) ** 2
      }
    }
    return { span, u, tol, depth, yaw, pitch, part, fade }
  }
  type State = ReturnType<typeof state>

  const glyphOffset = (g: number, s: State, t: number) => {
    const k = s.part
    const mid = (glyphCount - 1) / 2
    return {
      x: (g - mid) * 0.22 * k,
      y: Math.sin(g * 2.1 + t * 3) * 0.18 * k,
      z: (rnd(g * 7 + 1) - 0.5) * 1.2 * k,
      spin: (g % 2 === 0 ? 1 : -1) * k * Math.PI * 0.5,
    }
  }

  const drawSolid = (t: number, s: State) => {
    if (!device || !gpu) throw new Error('The text-glyph-outlines preview needs WebGPU (host.gpu)')
    // The lens shifted so the origin lands on (CX, CY), as in the 2D views.
    const proj = perspective(FOV, width / height, 0.1, 50, (2 * CY) / height - 1)
    const view = translate(0, 0, -DISTANCE)
    const model = mul(rotX(s.pitch), rotY(s.yaw))
    const data = new Float32Array(16 * 2 + 4 + 4 * MAX_GLYPHS * 2)
    data.set(mul(proj, view), 0)
    data.set(model, 16)
    const kick = Math.exp(-Math.max(0, t - 3) / 0.25) * (spans.length > 1 ? 1 : 0)
    data.set([Math.max(0.0005, s.depth), s.fade, 0.09 + 0.12 * s.part, kick], 32)
    for (let g = 0; g < glyphCount; g++) {
      const o = glyphOffset(g, s, t)
      const c = centres[g] ?? [0, 0]
      data.set([o.x, o.y, o.z, o.spin], 36 + g * 4)
      data.set(
        [c[0] ?? 0, c[1] ?? 0, (-DEPTH * Math.max(0.0005, s.depth)) / 2, 0],
        36 + MAX_GLYPHS * 4 + g * 4,
      )
    }
    device.queue.writeBuffer(gpu.ubuf, 0, data)
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: gpu.msaa.createView(),
          resolveTarget: gpu.target.createView(),
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: [0, 0, 0, 0],
        },
      ],
      depthStencilAttachment: {
        view: gpu.depth.createView(),
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
        depthClearValue: 1,
      },
    })
    pass.setBindGroup(0, gpu.group)
    pass.setVertexBuffer(0, gpu.vbuf)
    pass.setPipeline(gpu.faces)
    pass.setIndexBuffer(gpu.ibuf, 'uint32')
    pass.drawIndexed(solid.indices.length)
    pass.setPipeline(gpu.wire)
    pass.setIndexBuffer(gpu.ebuf, 'uint32')
    pass.drawIndexed(edges.length)
    pass.end()
    device.queue.submit([encoder.finish()])
    return gpu.target
  }

  // The 2D views, on the same frame as the solid's front face. Each glyph can ride its range.
  const glyphLift = (g: number, t: number, k: number) => Math.sin(t * 5.5 - g * 0.9) * 0.08 * k

  const drawOutlines = (o: Outlines, alpha: number, pen: number) => {
    ctx.globalAlpha = alpha
    // Set here: the fill rounds its joins, and a frame must not depend on the one before.
    ctx.lineJoin = 'miter'
    // The font's curves: on-curve points, control points, their handles.
    for (const g of o.glyphs) {
      let px = 0
      let py = 0
      for (const c of g.commands) {
        if (c.type === 'Z') continue
        if (c.type === 'Q' || c.type === 'C') {
          const controls =
            c.type === 'Q'
              ? [[c.x1, c.y1]]
              : [
                  [c.x1, c.y1],
                  [c.x2, c.y2],
                ]
          ctx.strokeStyle = 'rgba(255,59,31,0.55)'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(sx(px), sy(py))
          for (const [qx, qy] of controls) ctx.lineTo(sx(qx as number), sy(qy as number))
          ctx.lineTo(sx(c.x), sy(c.y))
          ctx.stroke()
          ctx.fillStyle = RED
          for (const [qx, qy] of controls) {
            ctx.beginPath()
            ctx.arc(sx(qx as number), sy(qy as number), 3.2, 0, Math.PI * 2)
            ctx.fill()
          }
        }
        ctx.strokeStyle = '#fff'
        ctx.lineWidth = 1.2
        ctx.strokeRect(sx(c.x) - 3.5, sy(c.y) - 3.5, 7, 7)
        px = c.x
        py = c.y
      }
    }
    // The flattened polylines and their points.
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.fillStyle = '#bdbdbd'
    for (let c = 0; c + 1 < o.contours.length; c++) {
      const a = o.contours[c] as number
      const b = o.contours[c + 1] as number
      ctx.beginPath()
      for (let i = a; i < b; i++)
        ctx.lineTo(sx(o.points[i * 2] as number), sy(o.points[i * 2 + 1] as number))
      ctx.closePath()
      ctx.stroke()
      for (let i = a; i < b; i++)
        ctx.fillRect(
          sx(o.points[i * 2] as number) - 1.5,
          sy(o.points[i * 2 + 1] as number) - 1.5,
          3,
          3,
        )
    }
    // A pen running along every contour at once.
    if (pen >= 0) {
      ctx.fillStyle = RED
      for (let c = 0; c + 1 < o.contours.length; c++) {
        const a = o.contours[c] as number
        const n = (o.contours[c + 1] as number) - a
        const i = a + (Math.floor(pen * n) % n)
        ctx.beginPath()
        ctx.arc(sx(o.points[i * 2] as number), sy(o.points[i * 2 + 1] as number), 6, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1
  }

  const drawFill = (index: number, t: number, s: State, alpha: number, lift: number) => {
    const fill = fills[index] as ReturnType<typeof triangulate>
    const P = fill.positions
    const all = spans.length > 1
    // Swept in left to right, in 'all' over its first half.
    const sweep = all ? ease(s.u / 0.55) : 1
    ctx.globalAlpha = alpha
    ctx.lineJoin = 'round'
    for (const [g, range] of fill.glyphs.entries()) {
      const dy = glyphLift(g, t, lift)
      for (let k = range.start; k < range.start + range.count; k += 3) {
        const a = fill.indices[k] as number
        const b = fill.indices[k + 1] as number
        const c = fill.indices[k + 2] as number
        const cx = ((P[a * 2] as number) + (P[b * 2] as number) + (P[c * 2] as number)) / 3
        const at = (cx - (ox - (x1 - x0) / 2)) / (x1 - x0)
        if (at > sweep * 1.1 - 0.05 + rnd(k) * 0.1) continue
        const h = rnd(k * 3 + index * 17)
        const fresh = clamp01(1 - (sweep * 1.1 - at) * 8)
        ctx.beginPath()
        ctx.moveTo(sx(P[a * 2] as number), sy((P[a * 2 + 1] as number) + dy))
        ctx.lineTo(sx(P[b * 2] as number), sy((P[b * 2 + 1] as number) + dy))
        ctx.lineTo(sx(P[c * 2] as number), sy((P[c * 2 + 1] as number) + dy))
        ctx.closePath()
        const lit = h > 0.94 || fresh > 0.5
        const [pr, pg, pb] = iridescent(at * 0.9 + t * 0.2)
        ctx.fillStyle = lit
          ? `rgb(${Math.round(pr * 255)},${Math.round(pg * 255)},${Math.round(pb * 255)})`
          : `rgb(${Math.round(40 + 70 * h)},${Math.round(40 + 70 * h)},${Math.round(40 + 70 * h)})`
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
  }

  /** The tiny labels: what the output holds now, and its tolerance or depth. */
  const measures = (s: State) => {
    const o = outlines[s.tol] as Outlines
    const fill = fills[s.tol] as ReturnType<typeof triangulate>
    const left =
      s.span.phase === 'outlines'
        ? `CONTOURS ${o.contours.length - 1}   POINTS ${(o.points.length / 2).toLocaleString('en-US')}`
        : s.span.phase === 'fill'
          ? `TRIANGLES ${(fill.indices.length / 3).toLocaleString('en-US')}   GLYPHS ${glyphCount}`
          : `VERTICES ${vertexCount.toLocaleString('en-US')}   TRIANGLES ${(solid.indices.length / 3).toLocaleString('en-US')}`
    const right =
      s.span.phase === 'solid'
        ? `DEPTH ${(DEPTH * s.depth).toFixed(3)} EM`
        : `TOLERANCE ${(TOLERANCES[s.tol] ?? 0).toFixed(4)} EM`
    return [left, right] as const
  }

  return {
    async render(t, o) {
      const s = state(t)
      const all = spans.length > 1
      uctx.fillStyle = '#000'
      uctx.fillRect(0, 0, width, height)
      behind.index()
      ctx.clearRect(0, 0, width, height)
      const layers: Layer[] = [{ color: under, name: 'index' }]
      if (s.span.phase === 'solid') {
        layers.push({ color: drawSolid(t, s), alpha: 'premultiplied', name: 'solid' })
        // In 'all', the outline it flattens into fades up over the last 0.3 s.
        if (all && t > 5.7) drawOutlines(outlines[0] as Outlines, smooth((t - 5.7) / 0.3), -1)
      } else {
        if (s.span.phase === 'outlines') {
          // A pen runs along every contour while the polylines refine.
          drawOutlines(outlines[s.tol] as Outlines, 1, (t / 1.5) % 1)
        } else {
          const lift = all ? Math.sin(clamp01(s.u) * Math.PI) : 1
          drawFill(s.tol, t, s, 1, lift)
        }
      }
      theme.words(TOPS, BOTTOMS, t, o.frame)
      theme.notes(NOTES, t, o.frame)
      const [left, right] = measures(s)
      theme.hud(t, o.frame, left, right)
      layers.push({ color: canvas, name: 'type' })
      return layers
    },
    status(t) {
      const s = state(t)
      if (spans.length === 1) return s.span.phase
      return `${String(spans.indexOf(s.span) + 1).padStart(2, '0')}/03  ${s.span.phase}`
    },
    inspect(t) {
      const s = state(t)
      const o = outlines[s.tol] as Outlines
      return {
        id: 'word',
        text: WORD,
        phase: s.span.phase,
        tolerance: TOLERANCES[s.tol] ?? 0,
        contours: o.contours.length - 1,
        points: o.points.length / 2,
        glyphs: o.glyphs.map((g: GlyphOutline, i) => ({
          id: `glyph-${i}`,
          unicode: g.unicode ?? null,
          bounds: g.bounds,
        })),
        depth: DEPTH * s.depth,
        yaw: s.yaw,
      }
    },
  }
}

export default textGlyphOutlines
