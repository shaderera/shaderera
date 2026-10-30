Primary grading as numbers: the ASC CDL, exposure in stops, contrast around a pivot and white balance, as WGSL functions for your own shader and a CPU version that gives the same values.

```ts
import { cdl, kelvinToXy, toMat3x3f, whiteBalance } from './color/primary.ts'
import { PRIMARY_WGSL } from './color/primary.wgsl.ts'

// once: footage lit at 3200 K shown as if lit by D65, as a matrix for a uniform
const wb = whiteBalance(kelvinToXy(3200))
host.gpu.queue.writeBuffer(wbBuffer, 0, toMat3x3f(wb))  // a 48-byte uniform buffer

// in your shader: balance and expose the scene-linear light, then grade it
const code = /* wgsl */ `${PRIMARY_WGSL}
@group(0) @binding(1) var<uniform> wb: mat3x3f;
@fragment fn gradeFs(i: V) -> @location(0) vec4f {
  let light = textureLoad(src, vec2u(i.pos.xy), 0).rgb;
  let lit = contrast(exposure(wb * light, 0.5), 1.2, 0.18);
  return vec4f(lit, 1.0);  // then the output transform
}`

// on the CPU, the same values: a swatch through a CDL
const swatch = cdl([0.4, 0.35, 0.3], [1.1, 1, 0.9], [0, 0, 0.02], [1, 1, 1], 0.9)
```

- `cdl(c, slope, offset, power, saturation)`: the ASC CDL v1.2. Per channel
  `clamp(c × slope + offset)` to 0–1, then `^power`; then saturation around Rec.709 luma
  (0.2126, 0.7152, 0.0722), clamped to 0–1 again. The order and the clamps are the spec's.
  Slope 1, offset 0, power 1 and saturation 1 change nothing on 0–1. The saturation weights are
  Rec.709, as the spec says: on BT.2020 or ACEScg data they misweight (BT.2020 red by about −0.3
  stops).
- `exposure(c, stops)`: the light times 2^stops.
- `contrast(c, amount, pivot)`: `pivot × (c / pivot)^amount`, for scene-linear light. The pivot
  (mid grey, 0.18, is the CPU default) stays put and each stop from it becomes `amount` stops;
  0 and negatives pass through. The pivot must be above 0 (the CPU throws). On log values the
  same move is `(c − pivot) × amount + pivot`, one line.
- `whiteBalance(source, target)` (CPU): the 3×3 matrix that shows what the source white lit as if
  the target lit it, D65 by default, through a Bradford adaptation, for linear Rec.709 / sRGB
  primaries. `wb * c` in WGSL; `applyMatrix(wb, c)` on the CPU; `toMat3x3f(wb)` lays it out as a
  `mat3x3f` for a buffer. `bradford(source, target)` is the same adaptation on XYZ.
- `kelvinToXy(kelvin)` (CPU): a colour temperature's white, 1667–25000 K, on the Planckian
  locus by Kim et al.'s cubic spline, as cameras and DNG take it. 2856 K is illuminant A; 6504 K
  is the black body at 6504 K (0.3134, 0.3236), not D65 (0.3127, 0.3290), which sits above the
  locus: for D65 pass `D65`. A white measured off a grey card works as well: its xy.

In WGSL the functions take and give `vec3f`; on the CPU, `[r, g, b]`, and every argument after
the colour has its identity default. The WGSL and the CPU agree within one 8-bit step, and the
test checks it on the GPU. Every default is identity on 0–1; outside it the CDL clamps.

Where it goes. It works on whatever values it is given, and it converts no spaces. White balance,
exposure and contrast are moves on scene-linear light: the film's light before the output
transform (`look-tonemap`, then `toSrgb` from `render-srgb`). White-balance before anything
clips: a clipped highlight, corrected, turns cyan. The CDL clamps to 0–1, as v1.2 does, so on
scene-linear light it would clip everything past 1: use it on log-encoded values (a log working
space, such as ACEScct, with your own curve in and out) or on display values 0–1.
All of it goes before a display LUT (`color-lut`), which comes last.

This does one job. Tint is not here: move the source xy off the locus yourself. Nor is
lift/gamma/gain: there is no one standard mapping of it to the CDL, so it is left out rather than
guessed. CDL files (`.cdl`, `.cc`, `.ccc`) are read and written by `color-cdl-files`. There is no unclamped CDL variant.
