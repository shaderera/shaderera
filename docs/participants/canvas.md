# Canvas2D

Canvas2D needs no dependency. The host hands over two ports:

- **`io.canvas(w, h)`**: an `OffscreenCanvas` in the browser Worker, an `@napi-rs/canvas` canvas
  in Node. Only the 2D context is portable.
- **`io.font(path, family)`**: registers a font file of the project (TTF or OTF) under a
  family name, in both hosts.

Return the canvas itself as the layer; the host reads its pixels (straight alpha).

## Minimal integration

```ts
import type { Open } from '@shaderera/core'

// The project's own files: a new project has no fonts or sounds (guides/typography.md).
const FONTS = [
  ['src/assets/fonts/NotoSans-Bold.ttf', 'Noto Sans Bold'],
  ['src/assets/fonts/NotoSansThai-Bold.ttf', 'Noto Sans Thai Bold'],
] as const

const title = { id: 'title', text: 'Programmable media', x: 160, y: 300, enter: 0 }

const open: Open = async ({ manifest, io }) => {
  for (const [path, family] of FONTS) await io.font(path, family)
  const { width, height } = manifest
  const type = io.canvas(width, height)
  const ctx = type.getContext('2d') as OffscreenCanvasRenderingContext2D

  const state = (t: number) => ({ title: { ...title, opacity: Math.min(1, t - title.enter) } })

  return {
    async render(t) {
      const s = state(t)
      ctx.clearRect(0, 0, width, height)
      ctx.font = '84px "Noto Sans Bold", "Noto Sans Thai Bold"'
      ctx.globalAlpha = s.title.opacity
      ctx.fillText(s.title.text, s.title.x, s.title.y)
      ctx.globalAlpha = 1
      return { color: type, name: 'Type' }
    },
    async inspect(t) {
      return state(t)
    },
    async audio() {
      return [{ src: 'src/assets/chime.wav', at: 0.4 }]
    },
  }
}

export default open
```

`render` and `inspect` call the same `state(t)`, so what you inspect is what was drawn. A source
may return several layers (a gradient `Background` and the `Type`), and the host composites them.

## Thai with `Intl.Segmenter`

Thai has no spaces between words. Canvas2D shapes it correctly (HarfBuzz through Skia in both
hosts) but does not wrap. Break at ICU word boundaries and measure with `measureText`:

```ts
const wrap = (ctx: Context, text: string, maxWidth: number): string[] => {
  const words = [...new Intl.Segmenter('th', { granularity: 'word' }).segment(text)].map(
    (s) => s.segment,
  )
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line + word
    if (line !== '' && ctx.measureText(next.trimEnd()).width > maxWidth) {
      lines.push(line.trimEnd())
      line = word.trimStart()
    } else line = next
  }
  if (line.trim() !== '') lines.push(line.trimEnd())
  return lines
}
```

Layout does not depend on `t`, so it is measured once in `open`. The result is inspectable:

```
$ shaderera inspect --time 2 --path paragraph.lines
paragraph.lines[0].text "Shaderera ทำให้ทุกเฟรม inspect ได้ เลื่อนไปที่เวลาใดก็ได้แล้วเห็น state,"
paragraph.lines[0].y 560
paragraph.lines[0].enter 0.8
paragraph.lines[0].width 1391.14
...
```

## Measured: browser vs Node

A Canvas2D type film at t = 3 s, 1920×1080, in Chrome 154 (`OffscreenCanvas`) and Node 24.14
(`@napi-rs/canvas` 1.0.10) on one Windows 11 machine: an 84 px Latin title (Noto Sans Bold), an
84 px Thai line (Noto Sans Thai Bold) and a 48 px mixed paragraph wrapped as above, compared with
`diffPixels` (2026-10-08).

- **Same: shaping, fallback and line breaks.** Advances: title 1828.60 in both, Thai 1265.55 vs
  1265.54, the three paragraph lines 1391.14 / 1355.09 / 341.52 in both (HarfBuzz through Skia in
  both). Node falls back from Noto Sans to Noto Sans Thai per glyph, with no tofu.
  `Intl.Segmenter` gives the same three lines (the same ICU rules).
- **Different: glyph edges.** 2.03% of the type layer's pixels differ (mean 0.654), from
  anti-aliasing and sub-pixel placement: up to 1.4 px horizontally on large Latin type, none
  vertically. Node's ink is slightly lighter, most at 48 px. A linear gradient differs by exactly
  1 in 25% of channels. Over the whole frame 51.01% of pixels differ, mean 0.453.
- **Different: mixed-font ink boxes.** In Node, `actualBoundingBoxAscent/Descent` of a mixed-font
  string comes from the first font only (single-font boxes agree within 0.66 px). Lay out with
  advances (`width`).

So layout is portable and pixels are not: export a film from one host. For identical pixels across
hosts, render in one host, or set the type with a GPU text renderer both hosts run
([Glyph](glyph.md)).
