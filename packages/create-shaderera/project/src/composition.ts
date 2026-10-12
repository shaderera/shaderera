import type { Open } from '@shaderera/core'

/**
 * The film: `render(t)` returns the frame at t, the same frame every time. This one draws nothing
 * yet: it clears a texture on the host's GPU to black and hands it over as the frame.
 *
 * Everything else is yours: WGSL, three.js, Canvas2D, any library, several layers (return an
 * array, bottom to top). `host.gpu` is a plain WebGPU device, `host.io` reads project files, and
 * `host.seed` and `host.params` come from shaderera.json. The reference docs are in
 * node_modules/shaderera/docs/.
 */
const open: Open = (host) => {
  const device = host.gpu
  if (!device) throw new Error('This film needs WebGPU: install the `webgpu` package.')
  const { width, height } = host.manifest
  const frame = device.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  })

  return {
    render: async (_t) => {
      const encoder = device.createCommandEncoder()
      encoder
        .beginRenderPass({
          colorAttachments: [
            {
              view: frame.createView(),
              clearValue: [0, 0, 0, 1],
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        })
        .end()
      device.queue.submit([encoder.finish()])
      return { color: frame, alpha: 'opaque' }
    },
    dispose: () => frame.destroy(),
  }
}

export default open
