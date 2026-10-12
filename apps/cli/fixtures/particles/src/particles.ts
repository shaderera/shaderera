import type { Open } from '@shaderera/core'
import { frameAt } from '@shaderera/core'
import { readBuffer, readTexture } from '@shaderera/core/gpu'

/**
 * A stateful film: seeded particles stepped in a flow field once per frame, drawn as fading trails.
 * Frame n is what n steps from the seeded start make, so `render(t)` alone cannot produce it: the
 * manifest says `sequential`, the host steps the frames in order, and `checkpoint` lets it seek
 * back without replaying from frame 0.
 *
 * Every GPU resource is this source's own, on `host.gpu`: two particle buffers and two trail
 * textures used in turn (ping-pong), one compute pass, one render pass for the trail and the
 * points, one fullscreen pass to the frame, one readback.
 */
const open: Open = async ({ manifest, params, seed, io, gpu: device }) => {
  if (!device) throw new Error('particles needs WebGPU (host.gpu).')
  const { width, height, fps } = manifest
  const count = Number(params.count ?? 65536)
  const trail = Number(params.trail ?? 0.92)

  // The seeded start: a PRNG from host.seed, never Math.random.
  let rng = seed >>> 0 || 1
  const random = () => {
    rng ^= rng << 13
    rng ^= rng >>> 17
    rng ^= rng << 5
    return (rng >>> 0) / 2 ** 32
  }
  const start = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) start.set([random() * 2 - 1, random() * 2 - 1, 0, 0], i * 4)

  const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
  const particles = [0, 1].map(() =>
    device.createBuffer({ size: start.byteLength, usage: storage }),
  )
  const trails = [0, 1].map(() =>
    device.createTexture({
      size: [width, height],
      format: 'rgba16float',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    }),
  )
  const output = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })
  const uniforms = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  const module = device.createShaderModule({
    code: new TextDecoder().decode(await io.read('src/particles.wgsl')),
  })
  const advance = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'advance' },
  })
  const fade = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'full' },
    fragment: { module, entryPoint: 'fade', targets: [{ format: 'rgba16float' }] },
  })
  const add = { operation: 'add', srcFactor: 'one', dstFactor: 'one' } as const
  const points = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'point' },
    fragment: {
      module,
      entryPoint: 'glow',
      targets: [{ format: 'rgba16float', blend: { color: add, alpha: add } }],
    },
    primitive: { topology: 'point-list' },
  })
  const expose = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module, entryPoint: 'full' },
    fragment: { module, entryPoint: 'expose', targets: [{ format: 'rgba8unorm' }] },
  })
  // One set of bind groups per direction of the ping-pong: index i reads [i] and writes [1 - i].
  const groups = [0, 1].map((i) => {
    const [from, to] = [i, 1 - i] as const
    return {
      advance: device.createBindGroup({
        layout: advance.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 1, resource: { buffer: particles[from] as GPUBuffer } },
          { binding: 2, resource: { buffer: particles[to] as GPUBuffer } },
        ],
      }),
      fade: device.createBindGroup({
        layout: fade.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniforms } },
          { binding: 3, resource: (trails[from] as GPUTexture).createView() },
        ],
      }),
      points: device.createBindGroup({
        layout: points.getBindGroupLayout(0),
        entries: [{ binding: 5, resource: { buffer: particles[to] as GPUBuffer } }],
      }),
      expose: device.createBindGroup({
        layout: expose.getBindGroupLayout(0),
        entries: [{ binding: 4, resource: (trails[to] as GPUTexture).createView() }],
      }),
    }
  })

  /** The state: which buffer and trail hold the latest frame, and how many frames were stepped. */
  let current = 0
  let stepped = 0
  device.queue.writeBuffer(particles[0] as GPUBuffer, 0, start)

  return {
    async render(t, options) {
      const frame = options.frame ?? frameAt(t, fps)
      // A sequential source is handed its frames in order; anything else is a host bug.
      if (frame !== stepped) throw new Error(`particles: frame ${frame} after ${stepped - 1}`)
      device.queue.writeBuffer(
        uniforms,
        0,
        new Float32Array([frame, 1 / fps, width / height, trail]),
      )
      const g = groups[current] as (typeof groups)[number]
      const encoder = device.createCommandEncoder()
      const compute = encoder.beginComputePass()
      compute.setPipeline(advance)
      compute.setBindGroup(0, g.advance)
      compute.dispatchWorkgroups(Math.ceil(count / 256))
      compute.end()
      const light = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: (trails[1 - current] as GPUTexture).createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      })
      light.setPipeline(fade)
      light.setBindGroup(0, g.fade)
      light.draw(3)
      light.setPipeline(points)
      light.setBindGroup(0, g.points)
      light.draw(count)
      light.end()
      const out = encoder.beginRenderPass({
        colorAttachments: [{ view: output.createView(), loadOp: 'clear', storeOp: 'store' }],
      })
      out.setPipeline(expose)
      out.setBindGroup(0, g.expose)
      out.draw(3)
      out.end()
      device.queue.submit([encoder.finish()])
      current = 1 - current
      stepped = frame + 1
      return { color: await readTexture(device, output), alpha: 'opaque', name: 'Particles' }
    },
    async inspect() {
      return { id: 'particles', count, trail, seed, stepped }
    },
    checkpoint: {
      // The whole state after the last frame: the particles, the trail, and the frame count.
      save: async () => ({
        stepped,
        particles: await readBuffer(device, particles[current] as GPUBuffer),
        trail: await readTexture(device, trails[current] as GPUTexture, 8),
      }),
      restore: async (state) => {
        const s = state as { stepped: number; particles: Uint8Array; trail: Uint8Array }
        current = 0
        stepped = s.stepped
        device.queue.writeBuffer(particles[0] as GPUBuffer, 0, s.particles)
        device.queue.writeTexture(
          { texture: trails[0] as GPUTexture },
          s.trail,
          { bytesPerRow: width * 8 },
          [width, height],
        )
      },
    },
    dispose() {
      for (const r of [...particles, ...trails, output, uniforms]) r.destroy()
    },
  }
}

export default open
