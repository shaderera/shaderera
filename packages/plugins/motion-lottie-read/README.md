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
(no `expo.out`), smoothed or turned into a preset. Drawing the card is the film's. From
`motion-eases` it uses only `bezier`, `hold` and `linear`, each with every number from the file.

This is the reader for a file that is the spec
([decision 0032](https://github.com/shaderera/shaderera/blob/main/docs/adr/0032-reference-copying.md),
points 5 and 2). It does not write `shaderera.analysis/1` `reference-tracks`, so a film reads a
Lottie file through this API, not the shared reference reader; writing its declared keys into
`reference-tracks` is a follow-up ([#699](https://github.com/shaderera/shaderera/issues/699)).

- **Time.** A key's `frame` is the file's frame, as written; `t` is `frame / fr` in seconds.
  `valueAt(property, t)` takes the same seconds: the file plays from `in` to `out`
  (`ip / fr` to `op / fr`, the out point not included). Where it starts in the film is the
  film's. A layer's `st` and `sr` are kept as written; they time a precomp's contents, which are
  not read.
- **Units** are Lottie's, as written: position and anchor in pixels of the file's `w` × `h`,
  scale in percent, rotation and skew in degrees, opacity 0 to 100.
- **Properties** are every animatable entry of `ks`, by Lottie's name: `a`, `p` (or `px`,
  `py`, `pz` when split), `s`, `r`, `o`, `sk`, `sa`, and a 3D layer's `rx`, `ry`, `rz`, `or`.
  A name this reader does not know is still read, with its name as its label (`__proto__` too).
  A value is always an array, one number a dimension, and every key of a property has as many.
- **Keys** keep `s` as `value`, `e` as `end` (older files), `h` as `hold`, `o` and `i` as
  `out` and `in` (one x and y a dimension, or one for all), and `to` and `ti` as `pathOut` and
  `pathIn`.
- **valueAt.** The move from a key to the next is the cubic bezier from (0, 0) through `out`
  and `in` to (1, 1), solved with `motion-eases`' `bezier`, each dimension with its own handles
  when the file has them (else the first). The value moves from the key's `s` to the next key's
  `s` (else the key's `e`). Before the first key it is the first value; after the last, the last
  (an older file's last `e`). A hold keeps its value until the next key, then jumps.
- **Paths.** A move whose key has `to` or `ti` is eased by the first dimension's handles alone,
  as a player does, even when they are zero (then it is a straight move). With tangents not zero
  it follows the cubic from `s` through `s + to` and the end `+ ti`, by arc length, the ease
  setting how far along it is. An ease that overshoots stops at the ends of the path. Players walk
  a path in straight pieces, so one may differ from this by a fraction of a pixel.
- **3D orientation.** A player turns an animated `or` as a quaternion, not each angle on its own
  curve, so it is listed in `unsupported` and `valueAt` and `keysOf` refuse it. Its keys are read
  as written. A static `or` is a value like any other.
- **keysOf(property, dimension)** gives motion-keyframes keys, `[t, value, ease]`, for a film
  that asks for a `track()`. The dimension (0 for x, 1 for y…) is required. It gives the same curve as `valueAt`, and refuses a curved path,
  which no one-axis track is. `motion-keyframes` is not required: add it when a film wants this.
- **Listed in `unsupported`, never dropped:** what layers draw (`shapes`, `solid`, `image`,
  `text`, `precomp`, `audio`, any other layer type), `masks`, `effects`, `layer styles`,
  `time remap`, `track matte`, `auto-orient` (0 or false is off), `parenting` (each transform is the layer's own,
  not composed with its parent's), `motion blur`, `blend mode`, an animated `3D orientation`, an `expression` (its keys are
  read, the expression is not run), `slots`, `collapse transforms` (`ct`, 0 is off), a
  transform entry with no `k` (by its name), and any other field of the file or a layer this
  reader does not read, by its name (`markers`, the file's named segments, among them). Fields
  that change nothing are not listed: names (`nm`, `mn`, `cl`, `ln`), `hasMask`, `meta`, and
  `assets`, `fonts` and `chars`, which the layers that use them list. Each with where it is in
  the file.
- **Refused by name:** text that is not JSON (a byte order mark before it is fine), a file with no
  layers, a transform entry that is not a property (`{a, k}`), `fr` not above 0, `op` not after `ip` (the file's or a layer's), keys out of time order,
  a key with no value, keys of one property with different numbers of values, a move with no
  handles that does not hold, a handle's x outside 0 to 1, a `t` that is not a number, and a
  dotLottie (`.lottie`) archive: unzip it and read its `animations/<name>.json`.

Stateless: any t gives the same value whenever it is asked. No packages.
