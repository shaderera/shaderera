A hue, saturation and luma key to a soft matte, 0–1, so a grade touches one colour only (a sky, skin, a product), as a WGSL function for your own shader and a CPU version that gives the same values.

```ts
import { cdl } from './color/primary.ts'
import { keyUniform, qualify } from './color/qualifier.ts'
import { PRIMARY_WGSL } from './color/primary.wgsl.ts'
import { QUALIFIER_WGSL } from './color/qualifier.wgsl.ts'

// once: the sky's blues, not the pale haze near the horizon nor the noisy shadows, as a 48-byte uniform
const sky = {
  hue: { centreDeg: 215, widthDeg: 40, softnessDeg: 20 },
  saturation: { low: 0.25, high: 1, softness: 0.1 },
  luma: { low: 0.08, high: 1, softness: 0.04 },
}
host.gpu.queue.writeBuffer(keyBuffer, 0, keyUniform(sky))

// in your shader: grade the picture, then mix the grade in through the matte
const code = /* wgsl */ `${PRIMARY_WGSL}${QUALIFIER_WGSL}
@group(0) @binding(1) var<uniform> key: QualifierKey;
@fragment fn gradeFs(i: V) -> @location(0) vec4f {
  let c = textureLoad(src, vec2u(i.pos.xy), 0).rgb;
  let graded = cdl(c, vec3f(0.9, 0.95, 1.1), vec3f(0.0), vec3f(1.0), 1.2);
  return vec4f(mix(c, graded, qualify(c, key)), 1.0);
}`

// on the CPU, the same matte
const m = qualify([0.3, 0.5, 0.85], sky)
```

- A key has up to three ranges, and the matte is their product. A range left out passes
  everything, so `{}` keys the whole picture.
  - `hue: { centreDeg, widthDeg, softnessDeg }`: hues within `widthDeg / 2` of the centre,
    around 360°, so `{ centreDeg: 350, widthDeg: 40 }` keys reds from 330° through 0° to 10°.
    The hue is HSV's (0° red, 120° green, 240° blue), read as `color-curves` reads it, so a range
    keys the pixels a hue curve over the same degrees turns. `analysis-scopes`' BT.709 skin line
    (123° from +Cb to +Cr) is about 18.5° here.
  - `saturation: { low, high, softness }`: HSV saturation, 0 for a grey, 1 for a pure colour. A
    colour out of gamut, with a channel below 0, counts as 1.
  - `luma: { low, high, softness }`: Rec.709 luma (`0.2126 R + 0.7152 G + 0.0722 B`) of the
    values as given, so past 1 too on linear light.
- `softness` (or `softnessDeg`) widens each edge outward by that much with a smoothstep ramp:
  exactly 1 inside the range, exactly 0 past the softness, smooth between. 0, or left out, is a
  hard key. A key that is not a range throws: a value that is not finite, a softness or a
  `widthDeg` below 0, a `low` above its `high`.
- A grey has no hue, and its hue reads as 0° (red); a near-grey's hue jumps with each code of
  noise. So a hue range alone over reds keys greys, whites and blacks too. Give a hue key a
  saturation range with a low of a few percent, softened: that drops the mid and light greys.
  It is not enough on dark pictures: in near-black pixels a code or two of codec noise is a high
  HSV saturation (one code over a black of two is 0.5), so they stay keyed. Add a luma range with
  a low above the noise as well, as the example does.
- `qualify(c, key)` in WGSL takes a `QualifierKey`, the uniform `keyUniform(key)` packs (48
  bytes); `qualify(rgb, key)` on the CPU takes the key as it is.

Where it goes: key on the picture you grade, on the same values, before the grade changes them.
The ranges read the values as given, so a luma range on display values is not the one on ACEScct
or on linear light.

What it does not do, and what does:
- Mixing the grade through the matte is your shader's own: `mix(c, graded, m)`.
- An area or a window: multiply the matte by an `image-regions` mask (`maskOf`) in your shader,
  so no window plugin is needed.
- A cleaner matte: blur it with `look-blur`, rendered to a texture first. Shrinking or growing
  it is not here: that reads each pixel's neighbours, a second pass and another job.

This does one job: one pixel in, one matte value out. For a soft key the WGSL and the CPU agree
within one 8-bit step, and the test checks it on the GPU. A hard key can differ on a colour
exactly on an edge, as f32 and f64 round it: [29, 26, 11] of 255 is exactly 50°, so a hard
edge at 50° may take it on one and leave it on the other.
