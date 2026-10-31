Grading curves from control points: a master curve and R, G, B curves baked into a `color-lut` 1D LUT, and hue vs saturation and hue vs hue around the colour wheel, as a WGSL function and a CPU version that gives the same values.

```ts
import { applyLut, lutTexture } from './color/lut.ts'
import { LUT_WGSL } from './color/lut.wgsl.ts'
import { applyHueCurves, curvesLut, hueCurvesLut } from './color/curves.ts'
import { CURVES_WGSL } from './color/curves.wgsl.ts'

// once: the points into two tables, the tables into textures of host.gpu
const rgb = curvesLut({ master: [[0, 0], [0.25, 0.2], [0.75, 0.82], [1, 1]], blue: [[0, 0.04], [1, 1]] })
const hue = hueCurvesLut({
  hueVsSat: [[0, 1.2], [120, 0.6], [240, 1]],  // a saturation factor at each hue
  hueVsHue: [[0, 0], [30, 8], [60, 0]],       // an offset in degrees: oranges towards yellow
})
const rgbCurves = lutTexture(host.gpu, rgb)  // bind both createView()s as texture_2d<f32>
const hueCurves = lutTexture(host.gpu, hue)

// in your shader: the colour through the RGB curves, then the hue curves
const code = /* wgsl */ `${LUT_WGSL}${CURVES_WGSL}
@group(0) @binding(1) var rgbCurves: texture_2d<f32>;
@group(0) @binding(2) var hueCurves: texture_2d<f32>;
@fragment fn gradeFs(i: V) -> @location(0) vec4f {
  let c = textureLoad(src, vec2u(i.pos.xy), 0).rgb;
  return vec4f(applyHueCurves(hueCurves, lut1d(rgbCurves, c, vec3f(0.0), vec3f(1.0))), 1.0);
}`

// on the CPU, the same values
const [r, g, b] = applyHueCurves(hue, applyLut(rgb, [0.8, 0.4, 0.2]))
```

- A point is `[x, y]`, in any order. Every curve is a monotone cubic through its points
  (Fritsch–Butland's weighted harmonic mean tangent, as PCHIP has inside; at the first and last
  point, the end piece's own slope): exact at each point, never above or below the two either
  side, so a staircase stays a staircase. It is flat beyond the first and last point. Two points
  at the same x throw. Bracket a hue curve's change with points either side of it: a single point
  is a constant, so `[[30, 8]]` turns every hue by 8°.
- `curvesLut({ master, red, green, blue }, size = 1024)`: each channel through the master, then
  through its own curve, in one 1D LUT over 0–1. `applyLut` and `lut1d` (`color-lut`) apply it,
  and `writeCube` writes it as a `.cube` for Resolve. A curve left out, or `[]`, is the identity.
  Input past 0–1 clamps to the ends, as a LUT does. A piece narrower than one table step (a near
  vertical jump) misses its points in the table; raise `size` for one.
- `hueCurvesLut({ hueVsSat, hueVsHue }, size = 256)`: x is a hue in degrees. `hueVsSat` is a
  saturation factor (1 unchanged, 0 grey, 2 double; left out, 1), `hueVsHue` an offset in degrees
  (left out, 0). The last point joins the first across 360°, with the same value and slope there.
  The table is a 1D LUT of [factor, offset, 0] per hue, for `lutTexture` and `applyHueCurves`;
  not for `applyLut`, which clamps where hue wraps.
- `applyHueCurves(table, c)` in WGSL, and `applyHueCurves(lut, [r, g, b])` on the CPU: both curves
  read at the colour's own HSV hue (from the largest channel, 0° red, 120° green, 240° blue). The
  hue is turned keeping the largest and smallest channel; then the saturation is scaled around
  Rec.709 luma (as the CDL's is), which keeps luma. Turning a hue does not keep luma: red turned
  to green is brighter, and an 8° turn of oranges brightens skin by 7–13 of 255. A grey has no
  hue, so neither curve changes it.
- `spline(points)` and `hueSpline(points)`: the curves themselves, as functions, for a curve
  drawn in a UI or read on the CPU. `hueOf(rgb)`: the HSV hue in degrees.

Where it goes: on display values (after the tone map and `toSrgb`) the curves act as a
colourist's do on a Rec.709 picture; on ACEScct (`color-spaces`) they act on log values. Not on
linear light: the LUT stops at 1.

This does one job. Luma vs saturation, saturation vs saturation and a luma-only curve that keeps
chroma are not here. The WGSL and the CPU agree within one 8-bit step, and the test checks it on
the GPU.
