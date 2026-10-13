A 3D camera as keyframed shots (eye, target, lens, roll, shift, focus) that orbit, dolly, crane and cut over time; exact framing of a subject, lenses in millimetres, WebGPU matrices or a three.js camera, and a lens that opens for vertical variants.

```ts
import { applyToThree, cameraPath, cameraTrack, FILL, fit, lens, shot, viewProjection } from './motion/camera.ts'
import { glide, hold, settle } from './motion/keyframes.ts'

const hero = fit({ center: [0, 1, 0], radius: 1.2, azimuth: 20, elevation: 8, fov: lens(50), fill: FILL.medium, shift: [-1 / 6, 0] })
const camera = cameraTrack([
  [0, hero],
  [4, fit({ center: [0, 1, 0], radius: 1.2, azimuth: 70, fov: lens(50), fill: FILL.close }), glide],  // orbits, keeps distance
  [6, shot([0, 8, 14], [0, 0, 0], lens(24)), hold],                                                    // a cut to wide
  [9, shot([0, 3, 8], [0, 0.5, 0], lens(35), 0, { focus: 8, fStop: 2 }), settle(8)],                   // lands like a spring
])
const flythrough = cameraPath([shot([0, 2, 20]), shot([4, 1, 6]), shot([0, 1, -6], [0, 1, -20])], 10, 16, glide)

// in render(t)
const c = camera(t, W / H)               // a 9:16 frame opens the lens half way
applyToThree(c, threeCamera, W / H)      // three.js (shift via setViewOffset, focus)
device.queue.writeBuffer(uniforms, 0, viewProjection(c, W / H))  // or raw WebGPU
```

- A move swings round the target on an arc by default; give a shot `path: 'line'` for a fly-by.
- `cameraTrack` comes to rest on every key; `cameraPath` flows through all its shots in one move.
- It speaks core's camera contract: set `source.camera` to `cameraCapability(camera, W / H).capability`
  and render through `through(t, options.camera)`, so MCP and a host's free camera can see and take
  over the film's camera.
- Everything is a formula of t: no damping stepped per frame. For a damped feel use the `settle`
  ease; to follow a moving subject, read its track at `t - lag`.

Built on `motion-keyframes` and `format-safe-areas`, which `add` copies in with it. `focus` and
`fStop` are carried from shot to shot and set on a three.js camera, but nothing here blurs: depth
of field is the renderer's. Defaults: `fit` with a 35 mm lens, a medium shot, 10° above the
horizon.
