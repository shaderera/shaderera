// Experimental (docs/api.md): what a host needs to open a source as the shaderera CLI does. Usable,
// and may change in any release; a film never imports it.

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
  timecodeOf,
} from './time.ts'
