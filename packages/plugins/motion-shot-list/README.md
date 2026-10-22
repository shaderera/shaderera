Film time to shots: the shot on screen at t, its local time and progress, the source frame of its footage, and the transition's progress while the shot before is still showing.

```ts
import { shotAt, shotList } from './motion/shot-list.ts'

// in open: the footage, and the shots in order, plain data
if (!io.video) throw new Error('This film needs io.video.')
const sea = await io.video('footage/sea.mp4')
const clips = new Map([['footage/sea.mp4', sea]])
const list = shotList([
  { id: 'title', dur: 2 },
  { id: 'sea', dur: 3, transition: 0.5, src: 'footage/sea.mp4', fps: sea.fps, in: 4 },
])
list.closeAt                     // { 'footage/sea.mp4': 4.5 }: sea is on from 1.5 to 4.5 s

// in render(t)
const at = shotAt(list, t)       // { shot, leaving?, transition }
const { shot, local, progress, frame } = at.shot
// the shot cut to last, the seconds since its cut, 0 to 1 through it, and its source frame
if (shot.src === 'footage/sea.mp4' && frame !== undefined)
  await sea.frame(Math.min(frame, sea.frames - 1))  // clamped, if the shot runs past its source
at.leaving                       // the shot before, during the transition into this one
at.transition                    // 0 at the cut to 1 when the shot before is gone; 1 with none
```

It gives times and frame numbers only. It draws nothing: whether a transition is a dissolve, a
dip or a flash, and how a shot looks, is the film's code.

A shot is `{ id, dur, transition?, src?, fps?, in?, speed?, hold? }`, in seconds:
- Shots follow one another. `transition` is how long the shot before stays on screen after this
  one's cut, so this shot starts that much before the shot before ends. A shot's `dur` includes
  the transition out of it. 0, a hard cut, by default. At most two shots are on screen at once.
- `in` is the source time at the cut, `speed` the source seconds per film second (2 is twice as
  fast, -1 plays backwards from `in`), and `hold` the seconds at the shot's end that freeze on
  the picture reached when they start. `source` is the source time this gives.
- With `fps` (a number, as `clip.fps` gives it, or a fraction `"24000/1001"`), `frame` is the
  source frame showing: floored, never below 0. It is exact for NTSC rates, which it reads as
  their fractions, as `shaderera.json`'s `fps` is read. Backwards, frame i shows until its own
  start, so `in: 2` at 24 fps shows frame 47 first. Footage needs floor, where core's `frameAt`
  rounds to the nearest frame. Clamp the end to `clip.frames - 1` if a shot runs past its source.
- Before 0 it gives the first shot, past the end the last.
- `frame` and `leaving` are left out when there is none, not `null`. `inspect` takes JSON only,
  so give it `at.shot.frame ?? null` and `at.leaving?.shot.id ?? null`.
- `list.shots` is plain data, each shot with its `start` and `end`. Return it as is from
  `inspect(t)` at the top level, `{ shots: list.shots, ... }`, and `shaderera review` looks at
  each shot and at each transition's overlap (`docs/cli.md`).
- `shotList` throws on a list that cannot play, naming the shot: a `dur` of 0, a transition
  longer than either shot or into the first one, three shots on screen at once.

A film with many clips closes each when its shot ends (`docs/protocol.md`), or every decoder holds
memory to the end of the render:

```ts
const closed = new Set<string>()   // in open
// in render(t), each clip once
for (const [src, end] of Object.entries(list.closeAt))
  if (t >= end && !closed.has(src)) {
    closed.add(src)
    await clips.get(src)?.close()
  }
```

A `frame(i)` after `close()` opens the file again, so a render that jumps back still works.
