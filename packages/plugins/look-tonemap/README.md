Linear light to display-referred colour through Khronos PBR Neutral or AgX, as WGSL functions for your own shader and a CPU version that gives the same values.

```ts
import { agx, pbrNeutral } from './looks/tonemap.ts'
import { TONEMAP_WGSL } from './looks/tonemap.wgsl.ts'

// in your output shader: the functions, then your own exposure, white balance, encoding, dither
const code = `${TONEMAP_WGSL}
@fragment fn outputFs(i: V) -> @location(0) vec4f {
  let light = max(textureLoad(hdr, vec2u(i.pos.xy), 0).rgb, vec3f(0.0)) * u.exposure;
  return vec4f(toSrgb(pbrNeutral(light)), 1.0);   // or agx(light)
}`

// on the CPU, the same values: a swatch or a palette to match the picture
const [r, g, b] = pbrNeutral([2, 0.5, 0.1])
```

- `pbrNeutral(c)`: [Khronos PBR Neutral](https://github.com/KhronosGroup/ToneMapping/tree/main/PBR_Neutral)
  (start of compression 0.8 − 0.04, desaturation 0.15). Colours below the shoulder come out as
  they went in, less a 0.04 offset, so a product's base colour stays its own; highlights roll off
  to white and lose saturation. Linear 1.0 becomes 0.869.
- `agx(c)`: AgX as [three.js r186](https://github.com/mrdoob/three.js/blob/r186/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js)
  has it (`AgXToneMapping`, after Filament and Blender's AgX by Troy Sobotka): Rec.2020, the inset
  and outset matrices, a log2 range of −12.47393 to 4.026069 EV around middle grey, and the
  minimal polynomial sigmoid. A filmic look: brights desaturate towards white, middle grey 0.18
  becomes 0.215, and it never quite reaches white (0.997).

Both are functions of `vec3f` in WGSL and of `[r, g, b]` on the CPU. In: linear light, Rec.709 /
sRGB primaries, already exposed and white balanced, from 0 up; clamp negatives first. Out: linear
display-referred light, Rec.709 primaries, 0–1. The output is not encoded: your shader encodes it
to sRGB (or writes an `-srgb` target). AgX's sigmoid gives values for a 2.2-power display, and
`agx` ends with that 2.2 power, as three.js does, to give linear light like `pbrNeutral`; encoding
it with the sRGB curve is what three.js and Blender do too.

This does one job. It does not expose, white balance, encode to sRGB or dither: multiply the light
by your exposure and white balance before, and encode and dither after, in the same shader. The
WGSL and the CPU agree within one 8-bit step once encoded; the test checks it on the GPU.
