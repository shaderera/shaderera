// Internal: helpers for the shaderera CLI and Studio. Not part of the public API, not covered by semver.

export { toSrt, toVtt, windowCaptions } from './captions.ts'
export {
  type GpuCompositor,
  type GpuLayer,
  type GpuOutput,
  gpuCompositor,
  yuvFits,
} from './compositor.ts'
export { sampleTimes } from './determinism.ts'
export { fullDevice } from './device.ts'
export { gainAt, sampleClips } from './gain.ts'
export { sha256 } from './hash.ts'
export { checkManifest, withVariant } from './manifest.ts'
export { openSource } from './open.ts'
export { matte, over, type RgbaLayer, straight } from './over.ts'
export { paramDefaults } from './params.ts'
export {
  type Prepare,
  type Prepared,
  type Seekable,
  type SeekStats,
  seekable,
} from './sequential.ts'
export { formatShaderError, type Locate, type ShaderWatch, watchShaders } from './shaders.ts'
export { finalOnly, layerInfo } from './stack.ts'
export {
  dropFrame,
  fpsFraction,
  frameCount,
  framesOfTimecode,
  parseFps,
  timecodeOf,
} from './time.ts'
