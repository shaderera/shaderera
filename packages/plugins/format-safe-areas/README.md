Safe areas for text per format and platform, and the corner free for a credit.

```ts
import { freeCorner, safeArea } from './layout/frame.ts'

const a = safeArea(W, H, 'reels')          // { x, y, width, height, left, right, top, bottom } in px
ctx.fillText(title, a.x, a.y + a.height)   // never under the platform's buttons or caption line

const c = freeCorner([sx, sy], W, H, 'reels')   // or a box [x, y, w, h]: the corner farthest from it
ctx.textAlign = c.align                    // c.corner is 'tl' | 'tr' | 'bl' | 'br'
ctx.textBaseline = c.baseline
ctx.fillText(credit, c.x, c.y)             // a source credit where there is room, inside the safe area
```

With no platform, generic title-safe margins; Shaderera itself assumes none (decision 0011). `'reels'`
is Meta's Reels ads safe zone (14 % top, 35 % bottom, 6 % sides, read 2026-10-12). `'shorts'` and
`'tiktok'` estimate the right-hand button rail and the bottom caption line; check the platform's
current safe-zone files before a delivery. To have review check text against one, put it in
requirements.json `safeArea` as fractions. Relay each format; never crop one from another.
