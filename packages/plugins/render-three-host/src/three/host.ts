// three.js on the host's GPU, deterministic: one WebGPURenderer on host.gpu, a scene rendered at t
// into a linear HDR target, tone-mapped and sRGB-encoded into the frame, and handed to the host as
// a layer. The traps it closes, each found the hard way:
// - three advances its node clock from its own requestAnimationFrame loop (the wall clock): the
//   loop is stopped (in Node, given a frame source that never fires), and the clock is set to t
//   on every render;
// - every render adds the wall-clock time since the last one to that clock (nodeFrame.update reads
//   performance.now): update only counts the frame here, so the clock stays at t;
// - WebGPURenderer applies neither tone mapping nor sRGB when it renders into a target: an output
//   pass does both;
// - multisampling a target that blends (a card's alpha, a reflection) is not deterministic on
//   Dawn/D3D12: samples default to 0;
// - in Node there is no canvas element: a stand-in object is enough for a renderer that only draws
//   into targets;
// - cameras need WebGPU's clip space (z 0–1).

import type { Host, Layer, RenderOptions } from '@shaderera/core'
import { renderOutput, texture } from 'three/tsl'
import * as THREE from 'three/webgpu'

type Internals = {
  _animation: { stop(): void }
  _nodes: { nodeFrame: { update(): void; frameId: number; time: number; deltaTime: number } }
  backend: { get(o: unknown): { texture?: GPUTexture } }
}

export type ThreeHostOptions = {
  /**
   * Tone mapping for the output pass. None by default: colours come out as written (a paper
   * #F7F5F0 stays #F7F5F0, artwork keeps its colours). For a lit 3D scene with bright lights, use
   * THREE.ACESFilmicToneMapping or THREE.NeutralToneMapping.
   */
  toneMapping?: THREE.ToneMapping
  exposure?: number
  /** MSAA samples for the scene: 4 smooths geometry edges, but see the note on blending above. */
  samples?: number
  /**
   * 'texture' (default) hands the host the frame's GPU texture with no copy; 'bytes' reads it back
   * to RGBA bytes, for a host or tool that composites on the CPU.
   */
  output?: 'texture' | 'bytes'
}

/**
 * A camera in WebGPU's clip space, its vertical field of view in degrees as three.js takes it. Set
 * it with camera-keyframes' applyToThree or by hand.
 */
export const threeCamera = (aspect: number, fovDeg = 40) => {
  const camera = new THREE.PerspectiveCamera(fovDeg, aspect, 0.05, 2000)
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem
  return camera
}

/** WebGPU pads read-back rows to 256 bytes: the rows without the padding. */
const unpad = (pixels: ArrayBufferView, width: number, height: number): Uint8Array => {
  const raw = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)
  const row = width * 4
  const stride = Math.ceil(row / 256) * 256
  if (stride === row || raw.byteLength < stride * (height - 1) + row)
    return raw.subarray(0, row * height)
  const out = new Uint8Array(row * height)
  for (let y = 0; y < height; y++) out.set(raw.subarray(y * stride, y * stride + row), y * row)
  return out
}

export const createThreeHost = async (host: Host, o: ThreeHostOptions = {}) => {
  const gpu = host.gpu
  if (!gpu) throw new Error('render-three-host needs WebGPU (host.gpu)')
  let width = host.manifest.width
  let height = host.manifest.height
  const canvas = { width, height, style: {}, addEventListener() {}, removeEventListener() {} }
  const renderer = new THREE.WebGPURenderer({ device: gpu, canvas: canvas as never })
  const internals = renderer as unknown as Internals
  // three's loop takes `self` as its frame source when init creates it, and Node has none: a
  // source that never fires stands in while it is created, then is removed again.
  const g = globalThis as { self?: unknown }
  const stub = g.self === undefined
  if (stub) g.self = { requestAnimationFrame: () => 0, cancelAnimationFrame() {} }
  try {
    await renderer.init()
  } finally {
    if (stub) delete g.self
  }
  internals._animation.stop()
  const nodeFrame = internals._nodes.nodeFrame
  nodeFrame.update = () => {
    nodeFrame.frameId++
  }
  renderer.toneMappingExposure = o.exposure ?? 1

  const scene = new THREE.RenderTarget(width, height, {
    type: THREE.HalfFloatType,
    samples: o.samples ?? 0,
  })
  const frame = new THREE.RenderTarget(width, height)
  const output = new THREE.MeshBasicNodeMaterial()
  output.colorNode = renderOutput(
    texture(scene.texture),
    o.toneMapping ?? THREE.NoToneMapping,
    THREE.SRGBColorSpace,
  )
  const quad = new THREE.QuadMesh(output)

  return {
    renderer,
    /**
     * Renders `world` through `camera` at t and returns the frame as an opaque layer. Pass the
     * render options so the frame follows the host's size.
     */
    async render(
      world: THREE.Scene,
      camera: THREE.Camera,
      t: number,
      options?: Pick<RenderOptions, 'width' | 'height'>,
      name = 'three',
    ): Promise<Layer> {
      if (options && (options.width !== width || options.height !== height)) {
        width = options.width
        height = options.height
        scene.setSize(width, height)
        frame.setSize(width, height)
        renderer.setSize(width, height, false)
        if (camera instanceof THREE.PerspectiveCamera) {
          camera.aspect = width / height
          camera.updateProjectionMatrix()
        }
      }
      // The node clock at t, never the wall clock.
      nodeFrame.time = t
      nodeFrame.deltaTime = 0
      renderer.setRenderTarget(scene)
      renderer.render(world, camera)
      renderer.setRenderTarget(frame)
      quad.render(renderer)
      renderer.setRenderTarget(null)
      if ((o.output ?? 'texture') === 'texture') {
        const color = internals.backend.get(frame.texture).texture
        if (color) return { color, alpha: 'opaque', name }
      }
      const pixels = await renderer.readRenderTargetPixelsAsync(frame, 0, 0, width, height)
      return { color: unpad(pixels, width, height), alpha: 'opaque', name }
    },
    dispose() {
      scene.dispose()
      frame.dispose()
      output.dispose()
      renderer.dispose()
    },
  }
}
