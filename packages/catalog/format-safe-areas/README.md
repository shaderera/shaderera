Safe areas for text per format and platform, and the lens rule that keeps a 16:9 shot reading in 9:16.

```ts
import { safeArea, widenFov } from './layout/frame.ts'

const a = safeArea(W, H, 'reels')          // { x, y, width, height, left, right, top, bottom } in px
ctx.fillText(title, a.x, a.y + a.height)   // never under the platform's buttons or caption line

const fov = widenFov(Math.PI / 4, W / H)   // the lens for this frame: 16:9 keeps it, 9:16 opens half way
```

With no platform, generic title-safe margins; Shaderera itself assumes none (decision 0011). `'reels'`
is Meta's Reels ads safe zone (14 % top, 35 % bottom, 6 % sides, read 2026-10-12). `'shorts'` and
`'tiktok'` estimate the right-hand button rail and the bottom caption line; check the platform's
current safe-zone files before a delivery. To have review check text against one, put it in
requirements.json `safeArea` as fractions. Relay each format; never crop one from another.
