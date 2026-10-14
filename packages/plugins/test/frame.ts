// Shared by the looks tests: a Dawn device and a host on it, frames made from a function of the
// pixel, and frames read back. Dawn's instance is held here, so it outlives every pending readback.

import assert from 'node:assert/strict'
import { Canvas } from '@napi-rs/canvas'
import type { Host } from '@shaderera/core'
import { readTexture } from '@shaderera/core/gpu'
import { create, globals } from 'webgpu'

Object.assign(globalThis, globals)
const gpu = create([])

export type Rgba = readonly [number, number, number, number]

export const openFrame = async (W: number, H: number) => {
  const adapter = await gpu.requestAdapter()
  assert.ok(adapter, 'a WebGPU adapter')
  const device = await adapter.requestDevice()
  const errors: string[] = []
  device.addEventListener('uncapturederror', (e) =>
    errors.push((e as GPUUncapturedErrorEvent).error.message),
  )
  const host = {
    manifest: { entry: '', width: W, height: H, fps: 30, duration: 1 },
    gpu: device,
    io: { canvas: (w: number, h: number) => new Canvas(w, h) as unknown as OffscreenCanvas },
  } as unknown as Host
  return {
    device,
    host,
    /** A W×H texture from a function of the pixel, as RGBA bytes; and the bytes. */
    frame(rgba: (x: number, y: number) => Rgba) {
      const texture = device.createTexture({
        size: [W, H],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      const px = new Uint8Array(W * H * 4)
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set(rgba(x, y), (y * W + x) * 4)
      device.queue.writeTexture({ texture }, px, { bytesPerRow: W * 4 }, [W, H])
      return { texture, px }
    },
    read: (texture: GPUTexture) => readTexture(device, texture),
    /** Channel c of pixel (x, y) in bytes read back. */
    at: (b: Uint8Array, x: number, y: number, c = 0) => b[(y * W + x) * 4 + c] ?? -1,
    done() {
      device.destroy()
      assert.deepEqual(errors, [])
    },
  }
}

/** A grey as RGBA bytes. */
export const grey = (v: number): Rgba => [v, v, v, 255]
