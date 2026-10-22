// A Canvas2D canvas, or RGBA bytes, uploaded into a GPUTexture of host.gpu, for a WGSL pass to
// read. One texture per size, made on first use and written again on every upload. The bytes go
// in as they are: no colour conversion, straight alpha as Canvas2D keeps it.

import type { Host } from '@shaderera/core'

/** The format of every texture an upload gives: 8 bits a channel, the values as they are. */
export const CANVAS_TEXTURE_FORMAT = 'rgba8unorm' satisfies GPUTextureFormat

/** RGBA bytes, row by row from the top, 4 a pixel. */
export type RgbaPixels = {
  data: Uint8Array | Uint8ClampedArray
  width: number
  height: number
}

/** An uploader on host.gpu. Each one keeps its own textures, one per size. */
export const createCanvasTexture = (host: Host) => {
  const device = host.gpu
  if (!device) throw new Error('render-canvas-texture needs WebGPU (host.gpu)')
  const textures = new Map<string, GPUTexture>()

  return {
    /**
     * The pixels of `source` in a texture of host.gpu at its size, `rgba8unorm`. The texture is
     * this uploader's, reused for every upload of that size: the next upload of the same size
     * writes over it.
     */
    upload(source: OffscreenCanvas | RgbaPixels): GPUTexture {
      const { width, height } = source
      const data =
        'getContext' in source
          ? (source.getContext('2d') as OffscreenCanvasRenderingContext2D).getImageData(
              0,
              0,
              width,
              height,
            ).data
          : source.data
      if (data.length !== width * height * 4)
        throw new Error(
          `render-canvas-texture: ${data.length} bytes are not ${width}×${height} RGBA pixels`,
        )
      const key = `${width}x${height}`
      let texture = textures.get(key)
      if (!texture) {
        texture = device.createTexture({
          size: [width, height],
          format: CANVAS_TEXTURE_FORMAT,
          usage:
            GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
        })
        textures.set(key, texture)
      }
      device.queue.writeTexture(
        { texture },
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        { bytesPerRow: width * 4 },
        [width, height],
      )
      return texture
    },
    /** Destroys every texture this uploader made. */
    dispose() {
      for (const t of textures.values()) t.destroy()
      textures.clear()
    },
  }
}
