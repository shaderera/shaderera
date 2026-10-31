# Writing a plugin

How to make a plugin, test it, and share it: as one of Shaderera's official plugins, or from a
library of your own. The commands are in [plugins.md](plugins.md).

## What a plugin is

A plugin is code a film proved, packed so another film can start from it. `shaderera add`
copies its files into a project, and from then on they are that project's own code: the person
edits them, and nothing updates them behind their back. There are four types:
- `component`: a small piece of code (`text-scramble`, `audio-beat-clock`);
- `preset`: data only, nothing that runs (`format-placement-specs`);
- `media`: fonts, sound, models, images (`font-ibm-plex-mono`);
- `extension`: a package plugin, an npm package the project imports. `add` installs it and records
  it in the project's label; `remove` uninstalls it. It is the one type that is not copied.

A plugin carries no taste lock ([decision 0011](https://github.com/shaderera/shaderera/blob/main/docs/adr/0011-experts-and-agents-no-taste-lock.md)).
It gives a film data, ports and tools, and the film decides how its frames look. Plugins fall on
one side of a line:
- **Plumbing** carries no taste: music analysis, three.js on the host's GPU, image decoding. An
  agent may add one without being asked, instead of writing the same plumbing again.
- **Looks and motion** decide how a frame looks: a screen pass, kinetic type, captions, a camera
  move. An agent adds one only when the person asks.

Write a looks plugin as parameters a film can push anywhere, not as one style to take or leave.

## Anatomy

A plugin is a folder. `text-scramble`:

```
text-scramble/
  shaderera.item.json    the label
  README.md              what it does and the call to make
  src/type/scramble.ts   copied to the project's src/type/scramble.ts
  preview/               official plugins only; never published
```

### The label

`shaderera.item.json` says what the plugin is and what it needs. It is for finding plugins and
resolving requirements only: no host reads it to render, so nothing in it may change a frame.
`text-glitch-titles`:

```json
{
  "name": "text-glitch-titles",
  "type": "component",
  "title": "Glitch titles",
  "description": "Huge titles with a small note, several to a scene, swapping on the beat through ASCII noise, each placed anew in one of four layouts inside the safe area",
  "category": "Typography",
  "tags": ["titles", "title cards", "glitch", "launch", "feature list", "kinetic typography"],
  "version": "0.2.1",
  "licence": "MIT",
  "requires": {
    "items": { "text-scramble": "^0.3.0", "text-fit": "^0.2.0", "format-safe-areas": "^0.3.0" }
  },
  "files": ["src/type/titles.ts"]
}
```

`publish` checks the label. A missing required field, a bad version or range, or a file outside
the folder is an error; anything merely unusual is a warning.

| Field | Required | What it holds |
|---|---|---|
| `name` | yes | a package-style name, see [Naming](#naming) |
| `type` | yes | `component`, `preset`, `media` or `extension` |
| `title` | no | a short human name; the `name` when left out |
| `description` | no, warned | one line; search shows it |
| `category` | yes | which part of the work it covers. Components, presets and extensions: `Audio & Music`, `Analysis & Tracking`, `Typography`, `Looks`, `Color`, `Procedural & Particles`, `Transitions`, `Animation & Camera`, `Rendering`, `Layout & Formats`, `Assets & Rights`. Media: `Music`, `Sound Effects`, `Fonts`, `3D Models`, `Images`. Another category is a warning, read as a proposal |
| `tags` | no | free words for search: use, style, technique (`"beat sync"`, `"glitch"`) |
| `version` | yes | `x.y.z`, see [Versions](#versions) |
| `licence` | yes | an SPDX id: `MIT`, `OFL-1.1` |
| `requires.shaderera` | no | a range of the `shaderera` package: `">=0.1.0"`; `add` warns outside it |
| `requires.items` | no | components, presets or media copied in with it, by name and range: `{ "text-scramble": "^0.3.0" }` |
| `requires.packages` | no | npm packages the copied code imports, installed unless the project has them: `{ "three": "0.186.1" }` |
| `requires.extensions` | no | package plugins it needs, installed and recorded in the project's label |
| `files` | for copied types | paths relative to the folder, copied to the same paths in the project. A folder is copied whole. No absolute paths, no `..` |
| `source` | for media | where it came from: `{ "origin": "https://github.com/IBM/plex" }`. Generated media adds `generator` and that generator's `terms` |

An `extension` carries the same fields under `"shaderera"` in its package.json. Its name, version,
description and licence come from the package, `requires.shaderera` from its
`@shaderera/core` peer dependency, and its files are what `npm pack` packs.

### The README

`README.md` beside the label is published with it. `info` prints it whole, and search reads its
first paragraph. So the first line is the one-line pitch, and the call to make comes right after.
`text-scramble`'s opens:

````
Canvas2D text that moves like data: ASCII scramble, decode-in and scramble-out, band glitch, hollow outlines.

```ts
import { decoded, glitched, scramble } from './type/scramble.ts'

const d = decoded('BEAT GRID', t, { start: 2, end: 4, frame: options.frame, seed: 1 })
```
````

After the call, say what a person needs to know and cannot see from it: what to run once
(`node tools/analyze-music.ts audio/song.mp3`), what it needs on the machine (ffmpeg), and its
limits.

### The files

Put each file at the path a project should get it, since `add` copies it there:
- code a film imports in `src/<area>/` (`src/music/beat.ts`, `src/type/scramble.ts`); the README's
  imports are relative to `src/composition.ts`, so `./music/beat.ts`;
- scripts a person runs once in `tools/` (`tools/analyze-music.ts`);
- fonts in `assets/fonts/`, with their licence text beside them;
- data in the folder the tools read it from (`delivery/placements.json`).

A plugin built on another imports it where that one lands: `text-glitch-titles` has
`import { decoded } from './scramble.ts'` and requires `text-scramble`. `add` never replaces a file
the project already has, so give files names that will not collide.

## Naming

Official plugins are named `<category>-<thing>`, so related ones sort together and the name says
what it is. The prefixes: `analysis`, `asset`, `audio`, `camera`, `color`, `font`, `format`, `image`,
`look`, `motion`, `render`, `review`, `text`. Examples: `audio-beat-clock`, `format-safe-areas`, `render-three-host`.

- A published name is permanent. Renaming one breaks every project and link that uses it, so
  choose before the first `publish`.
- Leave out the word "plugin": every one is.
- Do not start a name with "shaderera".
- Names are lowercase letters, digits, `.`, `_` and `-`, with an optional npm scope
  (`@team/text-stamp`).

## Rules the code follows

- **`render(t)` is a pure function of `t`.** The same `t` gives the same frame, whatever was drawn
  before. No `Math.random()`: derive randomness from `host.seed` and the frame, or hash it, as
  `text-scramble` does ("every choice is a hash of the frame and the character"). No wall clock:
  no `Date.now()`, `performance.now()` or `requestAnimationFrame`. See
  [determinism.md](determinism.md).
- **It runs headless in Node and in the browser.** Read files through `host.io.read`, make canvases
  with `host.io.canvas`, draw on the GPU with `host.gpu`. Project code may not write files or start
  programs, so heavy work goes in a `tools/` script run once, whose output the film reads as data:
  `audio-beat-clock` measures a song with `node tools/analyze-music.ts`, and `loadAnalysis(host, …)`
  reads the result at render time.
- **No film's numbers.** What a film would tune is a parameter, with a default that renders well:
  `decoded(text, t, { start, end, frame, rise: 0.3, fall: 0.15 })`,
  `hitsOf(analysis, { strength: 200 })`. Pass `t` and `frame` in; never assume a duration, a size
  or an fps.
- **Every asset is made in code, or comes with its licence and a recorded source.** The fonts ship
  with their OFL text and `source.origin`. AI-generated media records its generator and terms.

## Conventions

A film glues plugins together in its own code, so they name and measure the same things the same
way: what one returns, another takes as it is.

- **Time is in seconds**, as `t` is. A span of time is `start` and `end`, as core's `Caption` has
  them: `decoded(text, t, { start, end, frame })`, a title's `{ start, end, items }`, a silence's
  `{ start, end }`. Core's `AudioClip` keeps `from` and `to` for the stretch of its file to read.
  A frame number comes in only for what changes on every frame, such as noise; it never measures
  time.
- **Angles are in radians.** Degrees only where the name says so, as a camera operator says them:
  `fovDeg`, `azimuthDeg`, `lensDeg(50)`, `camera-shake`'s `degrees`.
- **A rectangle is `{ x, y, width, height }`**: its top-left corner and its size, in pixels with
  rows downward unless the README says otherwise. A point is a tuple, `[x, y]` or `[x, y, z]`. So
  `image-regions`' `box` goes straight into `camera-ken-burns`' `on` or `format-safe-areas`'
  `freeCorner`.
- **A colour is display values 0–1**, sRGB-encoded as a colour picker shows them, as a tuple
  `[r, g, b]`, unless its name says linear light (`look-tonemap`'s `LinearRgb`). Code spells it
  `color`, as core's `Layer.color`, WebGPU, CSS and three.js do. A Canvas2D plugin may take a CSS
  colour string, since that is what `fillStyle` takes, and `look-paper-edges` 8-bit values, since
  it mixes them into canvas pixels.
- **An analysis has one header**, the `shaderera.analysis/1` format of [analysis.md](analysis.md).
  The tool that writes it records its source and itself:

  ```json
  {
    "format": "shaderera.analysis/1",
    "kind": "music",
    "source": { "path": "audio/song.mp3", "bytes": 4818231, "sha256": "9f2c…", "seconds": 182.4 },
    "tool": { "script": "tools/analyze-music.ts", "ffmpeg": "ffmpeg version 7.1" },
    "params": { "fps": 60, "minBpm": 70, "maxBpm": 180 },
    "tempo": { "bpm": 160, "…": "the measurements follow" }
  }
  ```

  `source.path` is from the project root. The loader takes only where the artifact is (its path,
  or `image-regions`' folder), reads the source by `source.path`, and refuses another format or kind, or a source whose sha256 is not the
  recorded one: `loadAnalysis(host, 'audio/song.analysis.json')`. A check in the repository's
  tests fails on an official plugin's header in any other shape.
- **Core's types and helpers where they exist**, not a copy: `Vec3`, `Mat4`, `Matrices`, `Caption`,
  `DecodedImage`; `sha256(bytes)` for an analysis's hash and `parseFps(value)` for a rate as
  shaderera.json writes it (`30`, `29.97`, `"24000/1001"`), both from `@shaderera/core`.

## Versions

A published version is immutable. `publish` records the sha256 of its files, every `add` checks
the files against it, and `publish` refuses a version that is already there:
`text-scramble@0.3.0 is already published; bump the version`. To change a plugin, bump `version`.

Under 1.0 any minor may break. A fix is `0.1.0` → `0.1.1`; a change that breaks a caller is
`0.1.x` → `0.2.0`.

The ranges in `requires` are npm's: `1.2.3`, `>=0.1.0`, `<2`, `^0.1.0`, `~0.1.2`, `1.x`, `*`, and
alternatives joined with `||`. Pin npm packages a plugin is tested against exactly
(`"three": "0.186.1"`), and require other plugins by caret (`"text-scramble": "^0.3.0"`).

## Testing locally

Publish into a scratch folder, add from it into a fresh project, and look:

```sh
npx shaderera publish ./text-stamp --site ~/scratch-plugins   # checks the label, prints warnings
npx shaderera info text-stamp --site ~/scratch-plugins         # what a person will read
npx create-shaderera@latest stamp-test && cd stamp-test && npm install
npx shaderera add text-stamp --site ~/scratch-plugins
# call it from src/composition.ts, as the README says
npx shaderera check                     # the same t gives the same frame, in two orders
npx shaderera still 0 2.5 5 --sheet     # stills and a contact sheet
```

While you work, `publish --force` replaces a version in your scratch folder. Never use it on a
folder other people read.

For an official plugin, from a clone of the repository after `pnpm install`, use
`node apps/cli/bin/shaderera.js` in place of `npx shaderera`, add a test to
[packages/plugins/test/](https://github.com/shaderera/shaderera/tree/main/packages/plugins/test),
and run:

```sh
pnpm --filter @shaderera/plugins test   # every plugin renders, headless
```

## The preview

Every official plugin has a preview on shaderera.com: a 6 s square loop with its name and one
sentence saying what it does. It lives in the plugin's `preview/` folder, which is never in
`files`, so `add` and `publish` leave it out.

```
text-scramble/preview/
  preview.json   the caption, the states, the poster time
  index.ts       the picture; its default export is an OpenPreview
  make.ts        only when it makes assets (audio-beat-clock synthesises its music here)
```

`preview.json`:

| Field | What it holds |
|---|---|
| `caption` | one plain sentence for someone who has never seen the name: "Type that scrambles, decodes into place and glitches, in Canvas2D." |
| `states` | what a visitor can switch between, `{ "id", "label" }` each: `all`, `scramble`, `decode`, `glitch` |
| `default` | the state that plays first |
| `audio` | whether the default state's mp4 keeps its sound |
| `poster` | the time of the poster frame, in seconds |
| `crf` | optional x264 crf (20 by default); higher for a busy picture, to stay near 4 MB |

`index.ts` imports the plugin as `add` lays it out, from
`../../previews/src/<path>`, so a preview that renders proves the plugin works in a film. It draws
with [house.ts](https://github.com/shaderera/shaderera/blob/main/packages/plugins/previews/src/house.ts):

```ts
import { createHouse } from '../../previews/src/house.ts'
import type { OpenPreview } from '../../previews/src/preview.ts'
import { decoded, glitched } from '../../previews/src/type/scramble.ts'

const preview: OpenPreview = async (host, state) => {
  const canvas = host.io.canvas(host.manifest.width, host.manifest.height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  return {
    async render(t, o) {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      house.index()
      // the plugin doing its job: decoded(…), glitched(…)
      house.hud(t, o.frame, 'COLUMN 984 PX')
      return [{ color: canvas }]
    },
  }
}
export default preview
```

The house style is the opening film's:
- a black ground;
- big uppercase words in the top-left and bottom-right corners (`house.words`, `house.bigWord`)
  that decode in when they change;
- a small note in serif italic (`house.note`, `house.notes`);
- the HUD: tiny mono labels in the corners, t and the frame (`house.hud`);
- the plugin's index number, huge, faint and outlined, behind the picture (`house.index`);
- red (`RED`) for markers only.

The loop is 1080², 30 fps and 6 s. It must be seamless: frame 0 follows the last frame. Something
moves on every frame. Every asset is made in code: no photos, footage, music or fonts from outside
the repository (fonts come from the font plugins).

A preview shows only what you get by installing that plugin. Around the house frame, every visual
comes from the plugin's own calls, made the way its README shows. A subject the plugin acts on is a
plain stand-in, not a scene that reads as a feature. A font plugin's preview is a type specimen of
the weights and styles it ships. Its only motion is presentation: a steady drift, or a cut between
panels. Morphing type is `text-glyph-morph`'s preview, not a font's.

Render it, with ffmpeg and libwebp on the PATH:

```sh
node packages/plugins/previews/scripts/render.ts text-scramble
```

The renders land in `packages/plugins/text-scramble/preview/out/`: an mp4 per state, the loops,
`frames/` for scrubbing, `poster.png` and `poster.webp`. Look at the poster and at a contact sheet
of the loop (`still … --sheet --variant <name>`, from `packages/plugins/previews/`, as its
[README](https://github.com/shaderera/shaderera/blob/main/packages/plugins/previews/README.md)
shows). `out/` is gitignored and never committed: the preview is deterministic, so the code is
what is kept. A maintainer uploads the renders.

## Your own library

Any plugin, in any taste, can live in a library of your own. A library is a folder that `publish`
fills, or that folder served at a URL:

```sh
npx shaderera publish ./text-stamp --site ./r
```

`./r` then holds `index.json` (every plugin and version, with its sha256 and its files),
`search.json` (the search index) and `items/<name>/<version>/`. Host it as static files, as they
are: GitHub Pages, Cloudflare Pages or R2, or any static host. No server code runs; the index
lists every file a command fetches.

People reach it by choice:

```sh
npx shaderera add text-stamp --site https://you.example        # reads https://you.example/r
npx shaderera search stamp --site https://you.github.io/lib/r  # a URL with a path: that folder
```

Each command mirrors what it reads into `~/.shaderera/cache/`, checks it against the sha256, and
works offline from the last copy.

- People opt in. Never write a README or skill that tells agents to add your library on their
  own; an agent searches only where the person points it.
- Your library uses your own licence and your own names. The `<category>-<thing>` prefixes are a
  convention for the official plugins, and the naming rules above still help.
- Previews on shaderera.com are for official plugins only. Show yours however you like.

## Before a pull request

- The name is final, and the folder is `packages/plugins/<category>-<thing>/`.
- `publish` takes the label with no warning you cannot explain.
- The README's first line is the pitch, and the call follows it.
- `add` into a fresh project works, and `check` passes there.
- No film's numbers; the defaults render well.
- It follows the [conventions](#conventions): seconds and `start`/`end`, radians,
  `{ x, y, width, height }`, display colours, the analysis header, core's types.
- Every asset is made in code, or has its licence and source.
- A test in `packages/plugins/test/` (`<name>.test.ts`, or `<name>.it.ts` when it is slow);
  `pnpm --filter @shaderera/plugins test:all` passes.
- `preview/` renders, and you looked at the poster and a contact sheet. `out/` is not committed.
- A row in `packages/plugins/README.md`, and the plugin listed in `docs/authoring.md` as plumbing
  or as looks and motion.
- `pnpm test:all` and `pnpm lint` pass.
