A Lottie file's keyframes, read as written: its frame rate, in and out points, size and layers,
and each property of a layer's transform with its keys, holds and bezier handles. `valueAt`
plays a property with the file's own curves.

```ts
import { loadLottie, valueAt } from './motion/lottie.ts'

// in open
const lottie = await loadLottie(host, 'assets/intro.json')   // or readLottie(text or object)
const card = lottie.layers.find((l) => l.name === 'Card')
const p = card.transform.p                                   // px and py when position is split
lottie.unsupported                                           // [{ feature: 'shapes', where: 'layers[1].shapes' }…]

// in render(t)
const [x, y] = valueAt(p, t)                                 // t in seconds of the file
```

Plumbing: a Lottie file is the spec, so it is read, never re-derived or fitted. Nothing is named
(no `expo.out`), smoothed or turned into a preset. Drawing the card is the film's.

- **Time.** A key's `frame` is the file's frame, as written; `t` is `frame / fr` in seconds.
  `valueAt(property, t)` takes the same seconds: the file plays from `in` to `out`
  (`ip / fr` to `op / fr`, the out point not included). Where it starts in the film is the
  film's. A layer's `st` and `sr` are kept as written; they time a precomp's contents, which are
  not read.
- **Units** are Lottie's, as written: position and anchor in pixels of the file's `w` × `h`,
  scale in percent, rotation and skew in degrees, opacity 0 to 100.
- **Properties** are every animatable entry of `ks`, by Lottie's name: `a`, `p` (or `px`,
  `py`, `pz` when split), `s`, `r`, `o`, `sk`, `sa`, and a 3D layer's `rx`, `ry`, `rz`, `or`.
  A name this reader does not know is still read, with its name as its label. A value is always
  an array, one number a dimension.
- **Keys** keep `s` as `value`, `e` as `end` (older files), `h` as `hold`, `o` and `i` as
  `out` and `in` (one x and y a dimension, or one for all), and `to` and `ti` as `pathOut` and
  `pathIn`.
- **valueAt.** The move from a key to the next is the cubic bezier from (0, 0) through `out`
  and `in` to (1, 1), solved with `motion-eases`' `bezier`, each dimension with its own handles
  when the file has them (else the first). The value moves from the key's `s` to the next key's
  `s` (else the key's `e`). Before the first key it is the first value; after the last, the last
  (an older file's last `e`). A hold keeps its value until the next key, then jumps.
- **Paths.** A move with `to` or `ti` not zero follows the cubic from `s` through `s + to` and
  the end `+ ti`, by arc length, with the first dimension's ease setting how far along it is.
  An ease that overshoots stops at the ends of the path. Players walk a path in straight pieces,
  so one may differ from this by a fraction of a pixel.
- **keysOf(property, dimension)** gives motion-keyframes keys, `[t, value, ease]`, for a film
  that asks for a `track()`. It gives the same curve as `valueAt`, and refuses a curved path,
  which no one-axis track is. `motion-keyframes` is not required: add it when a film wants this.
- **Listed in `unsupported`, never dropped:** what layers draw (`shapes`, `solid`, `image`,
  `text`, `precomp`, `audio`, any other layer type), `masks`, `effects`, `layer styles`,
  `time remap`, `track matte`, `auto-orient`, `parenting` (each transform is the layer's own,
  not composed with its parent's), `motion blur`, `blend mode`, an `expression` (its keys are
  read, the expression is not run) and `slots`. Each with where it is in the file.
- **Refused by name:** text that is not JSON, a file with no layers, `fr` not above 0, `op` not
  after `ip`, keys out of time order, a key with no value, a move with no handles that does not
  hold, a handle's x outside 0 to 1, and a dotLottie (`.lottie`) archive: unzip it and read its
  `animations/<name>.json`.

Stateless: any t gives the same value whenever it is asked. No packages.
