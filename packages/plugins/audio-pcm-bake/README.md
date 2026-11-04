Bake sound made in code to an `.m4a` once, and refuse the file in `open` when the code that made it, its inputs, the seed or the duration change.

```sh
node tools/pcm-bake.ts src/music/bed.ts --out assets/music/bed.m4a --inputs data/parts.json --bitrate 192k
# writes assets/music/bed.m4a and assets/music/bed.stamp.json; prints the peak and the synthesis time
```

```ts
import { loadBaked } from './audio/baked.ts'

// in open
const bed = await loadBaked(host, 'assets/music/bed.m4a')  // refuses a stale file

// in audio()
return [{ src: bed, at: 0, group: 'music' }]
```

A long bed made in code, a minute or more, is too heavy to pass as `pcm` (see "Sound made in code"
in `docs/protocol.md` in the `shaderera` package). This tool renders it once to a file clip, and
the stamp keeps that file honest: a film never plays music its code no longer makes.

- **The module** exports a function `(duration, seed) => Pcm` (or a Promise of one): core's
  `{ sampleRate, channels }`, one or two `Float32Array`s of equal length. The tool calls the
  `default` export, or the one `--export` names, with `duration` and `seed` from `shaderera.json`
  (seed 0 when it has none). A function that needs more (parts, hits, a tempo map) gets a small
  export of its own that reads them, and those files are listed with `--inputs`.
- **The samples go in as they are**: f32le into ffmpeg's AAC, with no gain, limiting or
  normalising. The tool refuses NaN or Inf (naming the channel, sample and time), more than two
  channels or unequal lengths, and then writes nothing. It prints the peak, and says so over 1.
- `--bitrate` is ffmpeg's `-b:a` (`160k`, `192k`); ffmpeg's own default when left out.
- **The stamp**, `<name>.stamp.json` beside the file, is a `shaderera.analysis/1` artifact of kind
  `pcm-bake` (see `docs/analysis.md`): the module as its `source`; as `imports`, every project
  file the module imported at any depth (a shared synth, `audio-pcm-mix`, `audio-filters`),
  outside `node_modules`, as the tool loaded it; every `--inputs` file; the seed, the duration, the
  output's path, bytes, sha256 and peak, and the command that made it.
- **`loadBaked`** reads the stamp through `host.io.read` and refuses a file whose module, imported
  file or listed input has other bytes, whose seed is not `host.seed`, whose duration is not the
  film's, or whose own bytes changed, naming the command to run again. It returns the `src` for a
  clip.

**Limit:** imports are found by running them, but a file the module reads itself (`readFileSync`,
`fetch`) is not seen: list it with `--inputs`, or a change to it plays the old file without a
word. Packages in `node_modules` are not checked; the lockfile pins them.

Run it from the project root, with the module, the inputs and the output inside the project.
Needs ffmpeg on PATH.
