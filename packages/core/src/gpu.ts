/// <reference types="@webgpu/types" preserve="true" />
/**
 * EXPERIMENTAL: not covered by semver until real consumers justify it (roadmap §14).
 *
 * Readback for sources that render with WebGPU (`host.gpu`): the one step every such source writes
 * and gets wrong (rows padded to 256 bytes, a buffer to map, a copy out before unmap). Optional:
 * nothing in the protocol needs it, and a source keeps its own device, resources and passes.
 *
 * Ownership: the caller owns the texture or buffer read; these create a staging buffer, submit one
 * copy on `device.queue` after the work already submitted (queue order is the synchronisation), wait
 * for it, and destroy the staging buffer. The returned bytes are the caller's.
 */

/**
 * A 2D texture's first mip as tight rows: `width * bytesPerTexel` bytes each (4 for rgba8unorm and
 * bgra8unorm, 8 for rgba16float, 16 for rgba32float). The texture needs `COPY_SRC`.
 */
export const readTexture = async (
  device: GPUDevice,
  texture: GPUTexture,
  bytesPerTexel = 4,
): Promise<Uint8Array> => {
  const { width, height } = texture
  const tight = width * bytesPerTexel
  const padded = Math.ceil(tight / 256) * 256
  const staging = device.createBuffer({
    size: padded * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  try {
    const encoder = device.createCommandEncoder()
    encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow: padded }, [
      width,
      height,
    ])
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    const mapped = new Uint8Array(staging.getMappedRange())
    if (padded === tight) return mapped.slice()
    const out = new Uint8Array(tight * height)
    for (let y = 0; y < height; y++)
      out.set(mapped.subarray(y * padded, y * padded + tight), y * tight)
    return out
  } finally {
    staging.destroy()
  }
}

/** A buffer's bytes (all of it, or `size` from the start). The buffer needs `COPY_SRC`. */
export const readBuffer = async (
  device: GPUDevice,
  buffer: GPUBuffer,
  size = buffer.size,
): Promise<Uint8Array> => {
  const staging = device.createBuffer({
    size,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  try {
    const encoder = device.createCommandEncoder()
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, size)
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(GPUMapMode.READ)
    return new Uint8Array(staging.getMappedRange()).slice()
  } finally {
    staging.destroy()
  }
}

export { videoTexture, yuv420p10ToRgba, yuv420pToRgba } from './video.ts'
