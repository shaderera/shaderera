A log working space and wide gamuts: the ACEScct and ACEScc curves both ways, BT.1886 and the camera log curves (S-Log3, LogC3, LogC4, V-Log, Canon Log 3), as WGSL functions for your own shader and a CPU version that gives the same values, and the 3×3 matrices between Rec.709, Rec.2020, P3-D65, ACES AP0 and AP1 and the cameras' gamuts.

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
- The camera log curves, code value to linear light and back, named by the transfer
  `io.video(path, { transfer })` declares: `slog3ToLinear` and `linearToSlog3` (Sony S-Log3),
  `logc3ToLinear` and `linearToLogc3` (ARRI LogC3), `logc4ToLinear` and `linearToLogc4` (ARRI
  LogC4), `vlogToLinear` and `linearToVlog` (Panasonic V-Log), `clog3ToLinear` and
  `linearToClog3` (Canon Log 3, Canon's linear times 0.9, as the ACES IDTs scale it, so 18% grey
  is code 351). For these five transfers the decoder in WGSL is
  `${clip.space.transfer}ToLinear`, and on the CPU `TO_LINEAR[transfer]`; `bt709`, `srgb`, `pq`
  and `hlg` have none here, so check `transfer in TO_LINEAR` first.
- `logc3` is LogC3 at EI 800 only: other EIs have other curves.
- `rgbToXyz(gamut)` and `xyzToRgb(gamut)` (CPU): a gamut's linear RGB to CIE XYZ and back, its
  white at Y = 1. `GAMUTS` has their primaries and whites: `rec709` (BT.709, sRGB's too),
  `rec2020` (BT.2020), `p3d65` (P3 with D65, Display P3's), `ap0` (ACES2065-1) and `ap1`
  (ACEScg, ACEScct and ACEScc), from S-2014-004, and the cameras' with D65: `sgamut3` and
  `sgamut3cine` (Sony), `awg3` and `awg4` (ARRI Wide Gamut 3 and 4), `vgamut` (Panasonic) and
  `cinemagamut` (Canon). A gamut of your own is `{ red, green, blue, white }` in xy.
- `gamutMatrix(from, to)` (CPU): one gamut's linear RGB to another's, through XYZ, with a Bradford
  adaptation when the whites differ: the ACES white (0.32168, 0.33767) is not D65, and Bradford
  is the CAT the ACES configs use. `toMat3x3f` (from `color-primary`) lays it out for a uniform;
  `applyMatrix` applies it on the CPU. The Sony, ARRI and Canon IDTs adapt to the ACES white
  with CAT02 instead, so their matrices to AP0 differ from this one's by up to 0.005 (neutrals are identical, saturated colours move by
  0.003 at most); between D65
  gamuts (a camera's to Rec.709 or Rec.2020) nothing is adapted and they agree.

Code values. The camera curves take a 10-bit code / 1023, the stored sample, which is how the
vendors give them (S-Log3's 18% grey is code 420). `videoTexture(device, clip, { bits: 10 })`
gives R'G'B' 0–1 for the nominal range (64–940 in a limited-range file), so for a limited-range
file (`clip.colour.range` is `limited`, most camera files) the code value is
`(876 * v + 64) / 1023`, within half a code; for a full-range file it is `v` itself. Decode first, then the matrix:

```wgsl
let v = textureLoad(footage, xy, 0).rgb;               // limited range, from videoTexture
let light = toRec709 * slog3ToLinear((876.0 * v + 64.0) / 1023.0);  // gamutMatrix('sgamut3', 'rec709')
```

In WGSL the curves take and give `vec3f`; on the CPU, one channel. The WGSL and the CPU agree
within one 8-bit step, and the test checks it on the GPU. The test also checks: ACEScct and
ACEScc against the specs' values, their breakpoints and round trips; AP0 and AP1 against
S-2014-004; Rec.709 to AP0 against the matrix OpenColorIO publishes; Rec.709 to Rec.2020 against
BT.2087, and back against BT.2407; each camera curve against its vendor's code values (S-Log3:
95, 420 and 598 for 0, 18% and 90%), against OpenColorIO 2.6's built-ins and round trips; and
each camera gamut against the primaries OpenColorIO's camera matrices imply.

Where it goes. Matrices work on linear light only, never on log or display values. A grade in a
log working space: linear Rec.709 into AP1, `linearToAcescct`, the CDL from `color-primary`
(it clamps to 0–1, which suits ACEScct), `acescctToLinear`, back to Rec.709, then the
output transform (`look-tonemap`, `toSrgb` from `render-srgb`). Light that leaves the Rec.709
gamut on the way back is negative in a channel: the output transform clips it. Grade with the CDL
on ACEScct, not ACEScc: ACEScc goes below 0 under linear 0.0012, and the CDL's clamp at 0 lifts
those shadows even with an identity grade.

This does one job. It never guesses a file's space: the film says what its footage is, in
`io.video(path, { transfer, gamut })`, and reads it back as `clip.space` (absent when nothing was
declared) to pick the curve and the matrix. PQ and HLG are not here: no film decodes them in a
shader yet. A declared `bt709` is the BT.709 OETF (the camera's curve), not `bt1886`, this
plugin's display curve. There is no generic `convert`: a curve, then a matrix, each one line.
