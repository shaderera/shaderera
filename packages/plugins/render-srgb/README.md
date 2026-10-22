The sRGB transfer functions, display values to linear light and back, as WGSL functions for your shader and a CPU version that gives the same values.

```ts
import { toLinear, toSrgb } from './render/srgb.ts'
import { SRGB_WGSL } from './render/srgb.wgsl.ts'

// in your shader: decode, work in linear light, encode
const code = /* wgsl */ `${SRGB_WGSL}
@fragment fn mixFs(i: V) -> @location(0) vec4f {
  let a = toLinear(textureLoad(src, vec2u(i.pos.xy), 0).rgb);
  return vec4f(toSrgb(mix(a, toLinear(u.tint.rgb), u.amount)), 1.0);
}`

// on the CPU, one channel: a colour to match the picture, or a pixel read back
const half = toSrgb(0.5)        // 0.7354, so 188 of 255
const grey = toLinear(128 / 255) // 0.2159
```

- `toLinear(c)`: a display value, sRGB-encoded, 0–1, to linear light. A straight line below
  0.04045, a 2.4 power above it.
- `toSrgb(c)`: linear light to a display value. It clamps to 0–1 first, so a light past white
  encodes as white; tone map it first (`look-tonemap`) if it should roll off.

These are the IEC 61966-2-1 curves, the ones an `-srgb` texture format applies in hardware. In
WGSL they take and give `vec3f`; on the CPU, one `number`. The WGSL and the CPU agree within one
8-bit step, and the test checks it on the GPU.

It does one job. Alpha is not part of it: unpremultiply before `toLinear`, and premultiply after.
It knows no other primaries or curves (Display P3, Rec.2020, PQ).
