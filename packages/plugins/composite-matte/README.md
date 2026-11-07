A track matte, as one WebGPU pass: one picture's luma or alpha decides where another shows. Type cut by a distressed print texture, footage seen through a word, a reveal by a painted mask.

```ts
import { createMatte } from './composite/matte.ts'

// in open
const matte = createMatte(host, { width: W, height: H })

// in render(t): the picture to keep, and the picture that says where
const color = matte.apply(title, { color: mask, alpha: 'opaque' }, { channel: 'luma' })
return [{ color, alpha: 'premultiplied' }]
```

- `channel` (required): `'luma'` keeps the source where the matte is light (Rec. 709 luma of its
  display values, times its own alpha, so a transparent matte cuts); `'alpha'` keeps it where the
  matte is opaque, whatever its colour.
- `invert` (false): the matte turned over, so a light matte cuts and a dark one keeps.

The source's own alpha is kept and multiplied by the matte. Nothing is added to the matte: to make
it harder or softer, grade it first (`color-curves` on its luma, `look-blur` for a softer edge).

A picture is a canvas (straight alpha, as Canvas2D keeps it), or `{ color, alpha }` as a protocol
layer declares it: a `GPUTexture` of `host.gpu` with `TEXTURE_BINDING`, or a canvas, with
`'premultiplied'`, `'straight'` or `'opaque'`. Both are at the frame's size; another size throws.
A still decoded with `io.image` is drawn into a canvas of the frame's size first (`image-fit`).

The output is premultiplied `rgba8unorm`, reused on every call. Needs WebGPU (`host.gpu`). Within
one Canvas2D canvas, `globalCompositeOperation = 'destination-in'` already cuts by alpha.
