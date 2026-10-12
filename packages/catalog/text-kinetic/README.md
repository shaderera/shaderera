Canvas2D text that moves like data: ASCII scramble, decode-in and scramble-out, band glitch, fit to width, hollow outlines.

```ts
import { decoded, fitWidth, glitched, scramble } from './type/kinetic.ts'

const font = '600 "IBM Plex Mono"'
const d = decoded('BEAT GRID', t, { from: 2, to: 4, frame: options.frame, seed: 1 })
if (d.visible) {
  ctx.fillStyle = '#fff'
  const size = fitWidth(ctx, font, 'BEAT GRID', W * 0.6)
  glitched(ctx, d.text, W / 2, H / 2, { font, size, frame: options.frame, align: 'center', amount: d.settled ? 0.2 : 1 })
}
ctx.fillText(scramble('174.3 BPM', options.frame, 0.4), 40, 40)   // a number that never settles
```

Deterministic: every choice is a hash of the frame and the character. Pass `options.frame`.
