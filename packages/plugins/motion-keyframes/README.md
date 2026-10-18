Keyframed values over time with easing: numbers, points and progress, asked for their value at t.

```ts
import { glide, progress, strike, track, track3 } from './motion/keyframes.ts'

const scale = track([[0, 1], [4, 1.2, glide], [6, 0.8, strike]])   // held, then eased into each key
const pos = track3([[0, [0, 0, 0]], [10, [2, 1, -3]]])
const fade = progress(t, 3.5, 4)                                    // 0 → 1 over half a second

// in render(t)
card.scale = scale(t)
```

Eases: `linear`, `smooth` (default), `strike` (a hit), `accel`, `glide`, `hold` (a cut), `sine`,
`expo`, `circ`, `back(overshoot)`, `settle(stiffness)` (a critically damped spring as a formula, the
damped feel with no state) and `bezier(x1, y1, x2, y2)` (a curve from a motion designer's editor).

A key is a tuple `[t, value, ease?]` or an object `{ id, at, value, ease? }`; one track can mix
them. The object form names the key: with `"stamp": true` in `shaderera.json` the build stamps it
with its `source` line, and `track.inspect(t)` (on `track3` too) reports the key the track moves
into at t, or rests on, so the tools can lead from the film to the key's line:

```ts
const x = track([
  { id: 'start', at: 0, value: 0 },
  { id: 'hit', at: 0.8, value: 760, ease: strike },
])

// in inspect(t)
return { id: 'square', x: x(t), key: x.inspect(t) }
// at t = 0.4, key is { id: 'hit', source: 'src/composition.ts:3:3', at: 0.8, index: 1, u: 0.5 }
```

`u` is how far the move into that key has gone, 0 to 1 and not eased (1 at rest). A tuple key
reports `{ at, index, u }` with no id.

A track comes to rest on every key. `path3(points, from, to, ease)` is one move through several
points that never stops between them: a centripetal Catmull-Rom curve at even speed.

Stateless: any t gives the same value whenever it is asked.
