A `.cube` LUT read, applied and written: a grade made in Resolve, bought or exported, in your own shader with tetrahedral interpolation, and a CPU version that gives the same values.

```ts
import { applyLut, lutTexture, readCube, writeCube } from './color/lut.ts'
import { LUT_WGSL } from './color/lut.wgsl.ts'

// once: the file into a LUT, the LUT into a texture of host.gpu
const lut = readCube(new TextDecoder().decode(await host.io.read('luts/grade.cube')))
const grade = lutTexture(host.gpu, lut)  // bind its createView() as a texture_3d<f32>

// in your shader: the function, then the colour through it, in the LUT's own space
const code = /* wgsl */ `${LUT_WGSL}
@group(0) @binding(1) var grade: texture_3d<f32>;
@fragment fn gradeFs(i: V) -> @location(0) vec4f {
  let c = textureLoad(src, vec2u(i.pos.xy), 0).rgb;
  return vec4f(lut3d(grade, c, vec3f(0.0), vec3f(1.0)), 1.0);  // the LUT's DOMAIN_MIN and _MAX
}`

// on the CPU, the same values: a swatch through the grade; and a table back to a file
const [r, g, b] = applyLut(lut, [0.8, 0.4, 0.2])
const text = writeCube(lut)
```

- `readCube(text)`: the Adobe and Resolve `.cube` format. `LUT_3D_SIZE` (2–256) or
  `LUT_1D_SIZE` (2–65536), `TITLE`, `DOMAIN_MIN` and `DOMAIN_MAX` (Resolve's
  `LUT_3D_INPUT_RANGE` too), `#` comments. A bad file throws and says what is wrong: no size, a
  size out of range, the wrong number of rows, a row that is not three numbers. A file with both
  sizes (a 1D shaper before a 3D table) is not read.
- `writeCube(lut)`: the LUT back to `.cube` text. Reading it again gives the same LUT.
- `applyLut(lut, [r, g, b])`: a colour through the LUT, clamped to its domain first. 3D:
  tetrahedral, the cell cut into six tetrahedra along its grey diagonal. 1D: each channel linear
  between the two entries either side.
- `lutTexture(device, lut)`: a 3D table as a size³ `rgba32float` 3D texture, a 1D one as a
  size × 1 2D texture, read with `textureLoad`, so no sampler.
- `lut3d(lut, c, domainMin, domainMax)` and `lut1d(…)` in WGSL, the same as `applyLut`.

The LUT's input and output spaces are its author's: a LUT made for log footage wants log in, and
one that gives display values gives display values out. The plugin converts no spaces; convert
before and after it in your own shader. No LUT ships with it.

Where it goes in a film that works in linear light: a display LUT (most creative LUTs, Rec.709 in
and out) goes after the tone map (`look-tonemap`) and `toSrgb` (`render-srgb`), and nothing
encodes again after it. A log-to-display LUT takes log-encoded light and replaces the tone map and
the encoding. Light past `DOMAIN_MAX` clamps to the last entry, so a LUT made for SDR clips an
`hdr10` film's highlights: use it on the `sdr` range only.

This does one job. There is no trilinear option. The WGSL and the CPU agree within one 8-bit step,
and the test checks it on the GPU with a 33³ LUT read from its file.
