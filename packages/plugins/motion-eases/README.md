Eases and progress: a 0–1 value shaped by an ease, the progress of t through a span, and an envelope over hit times.

```ts
import { clamp, envelope, glide, lerp, progress, smooth, strike } from './motion/eases.ts'

// in render(t)
const fade = progress(t, 3.5, 4, smooth)                  // 0 → 1 over half a second, smoothstep
const x = lerp(-200, 0, progress(t, 1, 2, strike))        // quartic out from -200 to 0
const flash = envelope(t, [1.5, 2, 2.5], { decay: 0.1 })  // jumps to 1 on each hit, then falls
const kick = envelope(t, hits, { attack: 0.02, decay: 0.25, combine: 'sum', limit: 1.5 })
```

Eases take u in 0–1: `linear`, `smooth` (smoothstep), `strike` (quartic out), `accel` (cubic in),
`glide` (cubic in-out), `hold` (0 until u is 1), `sine`, `expo` and `circ` (in-out),
`back(overshoot)`, `settle(stiffness)` (a critically damped spring as a formula, with no state)
and `bezier(x1, y1, x2, y2)` (CSS `cubic-bezier`, solved to the last bits even where its tangent
stands upright). `back`'s overshoot and `settle`'s stiffness have no default.

`progress(t, start, end, ease)` is 0 before `start`, 1 after `end` and eased between; the ease is
required.
`clamp(x, a = 0, b = 1)` and `lerp(a, b, u)` are the usual.

`envelope(t, times, { attack, decay, combine, limit })` is 0 before a hit, rises to 1 over `attack`
seconds (0: it jumps), then falls with time constant `decay` seconds (required). Where hits overlap,
`combine` takes the strongest (`'max'`, the default), only the latest at or before t (`'last'`),
or adds them (`'sum'`); `limit` caps the result. `times` can come from `audio-beat-clock`'s
`hitsOf`, in any order.

Pure functions of their numbers: any t gives the same value whenever it is asked.
