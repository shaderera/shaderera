Hear a recording with Earshot, keep the takes that match a description, and land each take's loudest moment on a hit point.

```sh
node tools/listen.ts audio/keys.wav "a single mechanical key press" --top 8
# writes audio/keys.trims.json
```

```ts
import { clipAt, loadTrims } from './audio/trims.ts'

// in open
const keys = await loadTrims(host, 'audio/keys.trims.json')  // refuses trims of other bytes
const takes = keys.trims.filter((k) => k.verdict === 'strong' && !k.cut)

// in audio(): a take per key press, its peak on the press
return presses.map((t, i) => ({ ...clipAt(keys, takes[i % takes.length], t), group: 'fx' }))
```

An agent cannot hear which moment of a recording is the clean key press, or that a whoosh is
loudest 300 ms into its file. [Earshot](https://github.com/Leonxlnx/earshot) hears it: two open
models on the CPU say how well each stretch fits a description. This plugin keeps its answer as
data the film reads, and adds what a film needs to sync.

- **A trim** is one take: `start` and `end` in seconds of the recording (the clip's `from` and
  `to`), Earshot's `z` and `verdict` (`strong`, `plausible`, `weak`, `no match`), its `kind`
  (`stroke` or `event` for onset-based takes, `window` for a plain stretch to crossfade), and
  `cut` when it starts or ends inside a sound.
- **The peak** is the centre of the take's loudest 5 ms, measured here with ffmpeg. `clipAt`
  starts the clip earlier by the peak's lead, so the loudest moment lands on the hit point. A
  click's peak sits a few ms in; a whoosh's can sit hundreds.
- **The file** is a `shaderera.analysis/1` artifact of kind `sound-trims` (see `docs/analysis.md`
  in the `shaderera` package): the recording's path and sha256 in `source`, Earshot's version in
  `tool`, the description in `params`, Earshot's own sentence in `heard`. `loadTrims` refuses
  trims of a recording whose bytes changed.

Earshot is your own install: Python 3.10+, CPU only, and about 1.4 GB of models on its first use.
Pass its Python with `--python` or `EARSHOT_PYTHON`. Each run loads the models again (20–40 s), so
for many searches use Earshot's MCP server, which keeps them loaded: save its `find` answer with
full output and give it here with `--answer`.

What to trust is Earshot's to say (its `docs/LIMITS.md`): a strong match on a single exposed
sound is reliable; tags inside a busy mix, genre and mood are hints; taste is not measured. Listen
to the final. Needs ffmpeg on PATH. Record each recording's source and licence (`asset-provenance`).
