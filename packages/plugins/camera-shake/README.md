Camera shake as a formula of t: a camera that breathes, is handheld, or takes the hits of the music, the same on every render.

```ts
import { hits, SHAKE, shake } from './motion/shake.ts'

// in render(t), after the camera track
let c = camera(t, W / H)
c = shake(c, t, SHAKE.breathe)                                  // alive, never still
c = shake(c, t, SHAKE.impact, hits(t, [clock.at(17), clock.at(25)], 0.3), 2)   // kicks on the drops
applyToThree(c, threeCamera, W / H)
```

Presets: `breathe`, `handheld-mild`, `handheld`, `impact`. Seeded noise and exponential hit
envelopes, both pure functions of t: no `Math.random`, no decay stepped per frame. It turns the
camera in its own space, so the authored target stays where it is. Built on `camera-keyframes`.
