import type { Open } from '@shaderera/core'

/**
 * A first frame that makes a pipeline and then takes 1.5 s, as a slow compile would; every frame
 * after it is quick, but for one at t ≥ 0.5 with `hang`, which never settles.
 */
const open: Open = ({ gpu, io, params }) => {
  if (!gpu) throw new Error('needs WebGPU')
  const canvas = io.canvas(4, 2)
  let compiled = false
  return {
    render: async (t) => {
      if (!compiled) {
        compiled = true
        const module = gpu.createShaderModule({ code: '@compute @workgroup_size(1) fn main() {}' })
        gpu.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } })
        await new Promise((done) => setTimeout(done, 1500))
      }
      if (params.hang && t >= 0.5) await new Promise(() => {})
      return { color: canvas }
    },
  }
}

export default open
