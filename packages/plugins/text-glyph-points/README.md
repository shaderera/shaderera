Text as a fixed point set, for particles that form a word or a name.

```ts
import { glyphPoints } from './procedural/glyph-points.ts'

// in open, after host.io.font('assets/fonts/IBMPlexMono-SemiBold.ttf', 'IBM Plex Mono SemiBold')
const mark = glyphPoints(host, { text: 'SHADERERA', family: 'IBM Plex Mono SemiBold', count: 1 << 18 })
// mark.points: Float32Array of x, y in text widths (x in [-0.5, 0.5], y up)
// mark.marks[6]: where "ERA" begins, to move part of the word separately
device.queue.writeBuffer(buffer, 0, mark.points)
```

The same text, font and seed always give the same points (picked by `motion-random`'s hash). The text is rasterised: for the
outlines themselves, parse the font.
