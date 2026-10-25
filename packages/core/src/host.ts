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
export {
  CODE_LIGHT,
  type LightLevels,
  lightReference,
  p010Reference,
  peakCode,
  type ReferenceLayer,
  rgb10Reference,
  whiteOf,
} from './hdr.ts'
export { type HdrCompositor, type HdrOutput, hdrCompositor, p010Fits } from './hdr-compositor.ts'
export { checkManifest, GRAPHICS_WHITE, withVariant } from './manifest.ts'
export { openSource } from './open.ts'
export { matte, opaque, over, type RgbaLayer, straight } from './over.ts'
export { paramDefaults } from './params.ts'
export {
  type Prepare,
  type Prepared,
  type Seekable,
  type SeekStats,
  seekable,
} from './sequential.ts'
export { formatShaderError, type Locate, type ShaderWatch, watchShaders } from './shaders.ts'
export { finalOnly, layerInfo, lightChecked, rangeOf } from './stack.ts'
export {
  dropFrame,
  fpsFraction,
  frameCount,
  framesOfTimecode,
  timecodeOf,
} from './time.ts'
