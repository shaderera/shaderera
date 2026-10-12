import type { Open } from '@shaderera/core'

/** Set once per module: the device is lost on the first render at t ≥ 0.5, never after. */
let lostOnce = false

/**
 * A frame whose colour comes back from the GPU (a buffer copied and mapped). The first render at
 * t ≥ 0.5 destroys the device first, as a driver reset would.
 */
const open: Open = ({ gpu, params }) => {
  if (!gpu) throw new Error('needs WebGPU')
  return {
    render: async (t, o) => {
      // An invalid shader: WebGPU reports it as an event, the frame still comes back.
      if (params.mode === 'invalid' && t >= 0.5) gpu.createShaderModule({ code: 'not wgsl' })
      const n = o.width * o.height * 4
      const src = gpu.createBuffer({
        size: n,
        usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      })
      const dst = gpu.createBuffer({
        size: n,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
      gpu.queue.writeBuffer(src, 0, new Uint8Array(n).fill(Math.round(t * 100)))
      const encoder = gpu.createCommandEncoder()
      encoder.copyBufferToBuffer(src, 0, dst, 0, n)
      gpu.queue.submit([encoder.finish()])
      if (t >= 0.5 && !lostOnce && params.mode !== 'invalid') {
        lostOnce = true
        gpu.destroy()
      }
      await dst.mapAsync(GPUMapMode.READ)
      const color = new Uint8Array(dst.getMappedRange().slice(0))
      for (let i = 3; i < n; i += 4) color[i] = 255
      dst.unmap()
      return { color, alpha: 'straight', name: 'gpu' }
    },
  }
}
export default open
