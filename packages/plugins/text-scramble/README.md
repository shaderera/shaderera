Canvas2D text that moves like data: ASCII scramble, decode-in and scramble-out, band glitch, hollow outlines.

```ts
import { decoded, glitched, scramble } from './type/scramble.ts'

// in open: await host.io.font('assets/fonts/IBMPlexMono-SemiBold.ttf', 'IBM Plex Mono SemiBold')
const font = '"IBM Plex Mono SemiBold"'   // a family alone: the size is put in front of it
const d = decoded('BEAT GRID', t, { start: 2, end: 4, frame: options.frame, seed: 1 })
if (d.visible) {
  ctx.fillStyle = '#fff'
  glitched(ctx, d.text, W / 2, H / 2, { font, size: 160, frame: options.frame, align: 'center', amount: d.settled ? 0.2 : 1 })
}
ctx.fillText(scramble('174.3 BPM', options.frame, 0.4), 40, 40)   // a number that never settles
```

Deterministic: every choice is a hash of the frame and the character (`motion-random`). Pass
`options.frame`: the noise then changes on every frame, so a 60 fps render flickers twice as fast
as a 30 fps one. For noise at one rate whatever the render's fps, pass a tick of your own,
`Math.floor(t * 30)`, as `frame`.

`font` is a family alone, with no size or weight: the functions write `${size}px ${font}`, and
`64px 600 "IBM Plex Mono"` is not a CSS font, so the canvas would fall back to another face.
Register each weight under its own family name.

To size the text to a width, use `text-fit`.
