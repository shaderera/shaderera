Deterministic random numbers from a seed: a hash of an integer, the same hash in WGSL, and a seeded stream.

```ts
import { hash, rnd, stream } from './motion/random.ts'
import { RANDOM_WGSL } from './motion/random.wgsl.ts'

// in render(t): a choice per frame and per character, the same whenever the frame is drawn
const flicker = rnd(options.frame * 131 + i * 7) < 0.3
const glyph = GLYPHS[hash(options.frame * 977 + i) % GLYPHS.length]

// in open: a run of numbers made once, the same run for the same seed
const next = stream(host.seed)
const stars = Array.from({ length: 500 }, () => [next(), next()])

// in your shader: the same hash on the GPU
const code = /* wgsl */ `${RANDOM_WGSL}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let cell = vec2u(p.xy) / 8u;
  return vec4f(vec3f(rnd(cell.x * 7919u + cell.y)), 1.0);
}`
```

- `hash(v)`: a 32-bit unsigned hash of an integer (PCG). `v` is cut to 32 bits first, so pass
  integers: mix a frame, an index and a seed by multiplying by primes and adding, as above.
- `rnd(v)`: `hash(v)` as a number in [0, 1).
- `stream(seed)`: a function that gives the next number in [0, 1) on each call (mulberry32). Use it
  in `open`, never in `render`: a stream depends on how many numbers were taken before, so a frame
  drawn out of order would differ. In `render`, hash the frame instead.

In WGSL, `hash(v: u32) -> u32` gives the same 32 bits as the CPU, and the test checks it bit for
bit on the GPU. `rnd(v: u32) -> f32` keeps the hash's top 24 bits, all an f32 holds exactly, so it
is the CPU's `rnd` rounded down to 2⁻²⁴. If your shader already has a `hash` or `rnd`, rename one.

It does one job. Noise (smooth values between the hashes) is not part of it: `camera-shake` builds
its noise on `hash`.
