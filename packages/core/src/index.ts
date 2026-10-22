// The stable API of @shaderera/core (docs/api.md). Host helpers live in ./host.ts, experimental.
export { checkDeterminism, type DeterminismFailure, type DeterminismReport } from './determinism.ts'
export { diffJson, type JsonChange } from './diff-json.ts'
export { diffPixels, type PixelDiff } from './diff-pixels.ts'
export { exportFrames, NotDeterministic, type Sink } from './export.ts'
export { sha256 } from './hash.ts'
export type * from './protocol.ts'
export { flattenFrame } from './stack.ts'
export { frameAt, frameTimes, parseFps } from './time.ts'
