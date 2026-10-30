# Glyph (world-space type)

[pmndrs/glyph](https://github.com/pmndrs/glyph) shapes with HarfRust (WASM) and draws MSDF text
as three.js objects. Shaderera adds nothing: the text lives in the same three.js scene and the
same `WebGPURenderer` pass as everything else, so depth is resolved inside one renderer: a Thai
line passes behind a mesh without any depth crossing the protocol.

## Fonts

Bake MSDF fonts once with Glyph's CLI and commit the `.font.glb`:

```sh
glyph bake --input NotoSans-Bold.ttf --output noto-sans-bold.font.glb --msdf --unicodes U+0020-007E
glyph bake --input NotoSansThai-Bold.ttf --output noto-sans-thai-bold.font.glb --msdf
```

## Minimal integration

The renderer setup is the [three.js](three.md) one (render target with `samples: 4`, sRGB). Then:

> **MSAA and determinism.** `samples: 4` smooths Glyph's edges and passed `check` for type over
> opaque geometry. Multisampling a target that also blends is not deterministic on Dawn/D3D12
> ([three.md](three.md#multisampling-with-blending)); `render-three-host` defaults to `samples: 0`.

```ts
import { glyph, msdf } from '@pmndrs/glyph'
import { ThreeConfig } from '@pmndrs/glyph/three'

await glyph.init()
const type = glyph.handle('shaderera-glyph-type', ThreeConfig)
const face = async (path: string) =>
  glyph
    .fontFace(new Blob([(await io.read(path)) as Uint8Array<ArrayBuffer>]), { format: msdf })
    .load()
const fonts = { latin: await face(FONTS.latin), thai: await face(FONTS.thai) }

const texts = RUNS.map((run) => {
  const text = type.createText({
    font: fonts[run.font],
    text: run.text,
    style: { fontSize: run.size, color: '#f4f1ea' },
  })
  text.position.set(...run.position)
  scene.add(text)
  return { run, text }
})
glyph.shape()
const measured = texts.map(({ run, text }) => {
  const m = text.measure()
  return { id: run.id, width: round(m.width), height: round(m.height), glyphs: m.glyphCount }
})
```

Font bytes come through `io.read`, so the same code runs in both hosts. Each run is a literal with
an `id`, and `inspect` reports it with Glyph's measurement, so `get_source { id: 'thai' }` lands
on the run's line.

`render(t)` places the camera and the scene from `t`, renders into the target and returns
`{ color: new Uint8Array(pixels.buffer), alpha: 'opaque', name: 'Glyph type' }`.

## Thai and U+200B

Glyph's line breaker has no Thai dictionary (UAX #14 class SA): without help it breaks only at
spaces. To wrap a Thai paragraph, insert U+200B (zero-width space) at `Intl.Segmenter` word
boundaries before handing the text to Glyph:

```ts
const breakable = [...new Intl.Segmenter('th', { granularity: 'word' }).segment(text)]
  .map((s) => s.segment)
  .join('​')
```

## Measured

`@pmndrs/glyph` 0.1.0 in Node 24.14, with `Text.measure()` and `Text.glyphs()` (no GPU needed),
Noto Sans Thai Bold and Noto Sans Bold baked to MSDF, at 84 px, against the Canvas2D widths in
[canvas.md](canvas.md#measured-browser-vs-node) (2026-10-08):

- **Advances agree with HarfBuzz/Canvas2D to 0.01 px:** Thai 1265.544 vs 1265.55; Latin 1828.596
  vs 1828.60.
- Thai (`สื่อที่เขียนด้วยโค้ด กำหนดได้ทุกเฟรม`): 37 glyphs for 36 code points, 0 missing, 10
  zero-advance marks with their own offsets, 26 clusters: what HarfBuzz shaping of Thai looks like.
- Wrapping at 700 px: raw text breaks only at the space (UTF-16 index 21); with U+200B it breaks
  at a word boundary (27 of 45).
- In a shot of four type runs (Node, Dawn): `check --samples 20` deterministic at 19.9 ms per
  frame; 150 frames in 2.5 s.

Not verified: per-glyph advances and offsets against HarfBuzz (Canvas2D exposes only the total
width), mark rendering at small sizes, Thai with a fallback stack.
