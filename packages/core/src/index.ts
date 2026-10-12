// The public API of @shaderera/core (semver-covered). Host helpers live in ./host.ts, internal.
export { checkDeterminism, type DeterminismFailure, type DeterminismReport } from './determinism.ts'
export { diffJson, type JsonChange } from './diff-json.ts'
export { diffPixels, type PixelDiff } from './diff-pixels.ts'
export { exportFrames, type Sink } from './export.ts'
export type * from './protocol.ts'
export { flattenFrame } from './stack.ts'
export { frameAt, frameTimes } from './time.ts'
