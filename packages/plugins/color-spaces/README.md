A log working space and wide gamuts: the ACEScct and ACEScc curves both ways and BT.1886, as WGSL functions for your own shader and a CPU version that gives the same values, and the 3×3 matrices between Rec.709, Rec.2020, P3-D65, ACES AP0 and AP1.

```ts
import { toMat3x3f } from './color/primary.ts'
import { PRIMARY_WGSL } from './color/primary.wgsl.ts'
import { gamutMatrix } from './color/spaces.ts'
import { SPACES_WGSL } from './color/spaces.wgsl.ts'

// once: the matrices for two uniforms (48 bytes each)
host.gpu.queue.writeBuffer(inBuffer, 0, toMat3x3f(gamutMatrix('rec709', 'ap1')))
host.gpu.queue.writeBuffer(outBuffer, 0, toMat3x3f(gamutMatrix('ap1', 'rec709')))

// in your shader: light into ACEScct, a CDL on the log values, and back to linear Rec.709
const code = /* wgsl */ `${PRIMARY_WGSL}${SPACES_WGSL}
@group(0) @binding(1) var<uniform> toAp1: mat3x3f;
@group(0) @binding(2) var<uniform> toRec709: mat3x3f;
@fragment fn gradeFs(i: V) -> @location(0) vec4f {
  let light = textureLoad(src, vec2u(i.pos.xy), 0).rgb;     // linear Rec.709
  let coded = linearToAcescct(toAp1 * light);
  let graded = cdl(coded, vec3f(1.05), vec3f(-0.01), vec3f(1.0), 1.0);  // saturation weighs Rec.709
  return vec4f(toRec709 * acescctToLinear(graded), 1.0);  // then the output transform
}`
```

- `linearToAcescct(v)` and `acescctToLinear(v)`: ACEScct (Academy S-2016-001). Log2 above 2^-7
  linear, a straight toe below it that meets the log there; mid grey 0.18 is 0.4135884. Decoding
  stops at 65504, half float's largest, as the spec does.
- `linearToAcescc(v)` and `acesccToLinear(v)`: ACEScc (S-2014-003), the same log with no toe:
  eased below 2^-15, and 0 and below give its floor, -0.3584. Mid grey is 0.4135884 too.
- `bt1886ToLinear(v)` and `linearToBt1886(v)`: ITU-R BT.1886 with white 1 and black 0, gamma 2.4;
  below 0 is 0. For sRGB's curve, use `render-srgb`.
- `rgbToXyz(gamut)` and `xyzToRgb(gamut)` (CPU): a gamut's linear RGB to CIE XYZ and back, its
  white at Y = 1. `GAMUTS` has their primaries and whites: `rec709` (BT.709, sRGB's too),
  `rec2020` (BT.2020), `p3d65` (P3 with D65, Display P3's), `ap0` (ACES2065-1) and `ap1`
  (ACEScg, ACEScct and ACEScc), from S-2014-004. A gamut of your own is
  `{ red, green, blue, white }` in xy.
- `gamutMatrix(from, to)` (CPU): one gamut's linear RGB to another's, through XYZ, with a Bradford
  adaptation when the whites differ: the ACES white (0.32168, 0.33767) is not D65, and Bradford
  is the CAT the ACES configs use. `toMat3x3f` (from `color-primary`) lays it out for a uniform;
  `applyMatrix` applies it on the CPU.

In WGSL the curves take and give `vec3f`; on the CPU, one channel. The WGSL and the CPU agree
within one 8-bit step, and the test checks it on the GPU. The test also checks: ACEScct and
ACEScc against the specs' values, their breakpoints and round trips; AP0 and AP1 against
S-2014-004; Rec.709 to AP0 against the matrix OpenColorIO publishes; Rec.709 to Rec.2020 against
BT.2087, and back against BT.2407.

Where it goes. Matrices work on linear light only, never on log or display values. A grade in a
log working space: linear Rec.709 into AP1, `linearToAcescct`, the CDL from `color-primary`
(it clamps to 0–1, which suits ACEScct), `acescctToLinear`, back to Rec.709, then the
output transform (`look-tonemap`, `toSrgb` from `render-srgb`). Light that leaves the Rec.709
gamut on the way back is negative in a channel: the output transform clips it. Grade with the CDL
on ACEScct, not ACEScc: ACEScc goes below 0 under linear 0.0012, and the CDL's clamp at 0 lifts
those shadows even with an identity grade.

This does one job. It never guesses a file's space: the film says what its footage is. Footage
reaches a film as 8-bit sRGB today, so camera log curves and gamuts (S-Log3, LogC3 and LogC4,
V-Log, Canon Log 3 and their gamuts) are not here yet; they follow footage that declares its
space. PQ is not here either. There is no generic `convert`: a curve, then a matrix, each one
line.
