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

Keep the bang clear: put no caption over the biggest moment of the music. Built on
`text-kinetic` and `format-safe-areas`, which `add` copies in with it.
