Big feature captions that swap through ASCII noise, several to a scene, each set somewhere new in one of four layouts (edge, split, column, spine).

```ts
import { createCaptions } from './type/captions.ts'

// in open (fonts registered with host.io.font first)
const captions = createCaptions({
  captions: [
    { from: clock.at(3), to: clock.at(5), items: [['AUDIO-DRIVEN', 'the line is the song'], ['BEAT GRID', 'cut on the 1/16']] },
  ],
  fonts: { title: '"IBM Plex Mono SemiBold"', small: '"IBM Plex Mono"', note: '"STIX Two Text Italic"' },
  swap: 2 * clock.beat,
  platform: 'reels',                 // for a vertical variant
})

// in render(t): a Canvas2D layer over the picture
ctx.clearRect(0, 0, W, H)
captions(ctx, W, H, t, options.frame)
```

A caption can have an `id` (`{ id: 'audio', from, to, items }`). With `"stamp": true` in
`shaderera.json` the build stamps that literal with its `source` line, and `captions.inspect(t)`
reports each caption showing at t, so the tools can lead from the film to its line:

```ts
// in inspect(t)
return { captions: captions.inspect(t) }
// [{ id: 'audio', source, from, to, item: 1, index: 1, title: 'BEAT GRID', note: 'cut on the 1/16', layout: 'split', u: 0.4 }]
```

`item` is the item showing in that caption, `index` its place among all the captions' items, and
`u` how far its hold has gone, 0 to 1. Drawing is unchanged: `captions(ctx, W, H, t, frame)`.

Keep the bang clear: put no caption over the biggest moment of the music. Built on
`text-scramble`, `text-fit` and `format-safe-areas`, which `add` copies in with it.
