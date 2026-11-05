A glTF file's animation clips, read as written: each channel's target node, path, interpolation,
key times and values exactly as the accessors hold them. `valueAt` plays a channel by the glTF 2.0
spec's own rules.

```ts
import { loadClips, valueAt } from './motion/gltf-clips.ts'

// in open
const { clips, skins, morphTargets, unread } = await loadClips(host, 'assets/arm.glb')
// or readClips(await openGltf(read, path)), openGltf from './render/gltf.ts'
const clip = clips.find((c) => c.name === 'Wave')       // { index, name, channels, start, end }
// clip.channels: [{ node: 3, nodeName: 'hand', path: 'rotation', interpolation: 'LINEAR',
//                   input: Float32Array, output: Float32Array, width: 4 }…]

// in render(t)
for (const ch of clip.channels) {
  const v = valueAt(ch, t)            // t in seconds of the file: [x, y, z], [x, y, z, w] or weights
}
```

Plumbing: a glTF clip is the spec, so it is read, never re-derived, fitted or eased
([decision 0032](https://github.com/shaderera/shaderera/blob/main/docs/adr/0032-reference-copying.md),
point 5). Applying the values to nodes, composing node matrices and drawing are the film's.
It reads the file with `render-gltf-read`'s `openGltf` and its accessor reader, so it takes what
that one takes (`.gltf` with its buffers, or `.glb`) and refuses what it refuses. No packages.

- **Channels.** One per channel of the animation, in the file's order: `node` is `target.node`
  (and `nodeName` the node's name when it has one), `path` is `translation`, `rotation`, `scale`
  or `weights`, `interpolation` the sampler's (`LINEAR` when the file leaves it out, as the spec
  says). `input` is the key times in seconds; `output` the values, `width` numbers a value (3, 4
  for a rotation's x, y, z, w, or the mesh's morph target count). A `CUBICSPLINE` output holds
  three values a key, as glTF stores them: in-tangent, value, out-tangent. Normalised integer
  outputs come back as −1–1 or 0–1, as the spec reads them.
- **Clips.** `start` and `end` are the first and last key time over the clip's channels, in the
  file's seconds. Where a clip starts in the film, and whether it loops, is the film's.
- **valueAt(channel, t)**, by the spec's interpolation appendix:
  - `STEP`: a key's value holds until the next key, then jumps;
  - `LINEAR`: (1 − u)·v₀ + u·v₁ with u = (t − t₀) / (t₁ − t₀); a rotation is slerped,
    a = acos(|q₀ · q₁|), sin(a(1 − u)) / sin(a) · q₀ + sign(q₀ · q₁) · sin(au) / sin(a) · q₁, and
    lerped where a is 0;
  - `CUBICSPLINE`: (2u³ − 3u² + 1)·v₀ + td·(u³ − 2u² + u)·b₀ + (−2u³ + 3u²)·v₁ + td·(u³ − u²)·a₁,
    with td = t₁ − t₀, b₀ the key's out-tangent and a₁ the next key's in-tangent; a rotation is
    normalised after, as the spec says.
  - Before the first key it is the first value; after the last, the last.
- **Present, not applied:** `skins` (index, name, joint count) and `morphTargets` (each mesh
  with targets, and how many). A `weights` channel's values are the target weights as written;
  skinning and morphing the mesh are the film's, or a later plugin's.
- **Listed in `unread`, by where:** a channel with no target node or a path an extension adds
  (`KHR_animation_pointer`).
- **Refused by name:** an interpolation the spec does not have, key times that do not ascend, an
  input with no keys, an output whose length is not keys × (3 for CUBICSPLINE, else 1) × width,
  a channel naming a node or sampler the file does not have, and a `t` that is not a number.

Stateless: any t gives the same value whenever it is asked.
