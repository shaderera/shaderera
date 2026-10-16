# Shaderera

Shaderera makes 2D/3D hybrid video in code. A film is `render(t)`; Shaderera does the production
work around it: checks, export, review, delivery and revisions.

## Language

### The film

**Project**:
A folder with a `shaderera.json` and the film's code. It is the whole film: there is no other
file that describes it.
_Avoid_: scene, template

**render(t)**:
The one function every film has: it takes a time in seconds and returns the frame at that time.
The same `t` always gives the same frame.
_Avoid_: seek, play, tick

**Source**:
The object a project's entry returns: `render(t)` and any optional capabilities.
_Avoid_: scene, clip, renderer

**Participant**:
A source that draws with one technology (Canvas2D, three.js, raw WebGPU, a DOM page, footage).
A film mixes any number of them.
_Avoid_: adapter, plugin

**Composition**:
A source that calls other sources at offset times and returns their layers together. Nesting
and shot switches are ordinary code in it.
_Avoid_: timeline, sequence, layer tree

**Frame**:
What `render(t)` returns: one layer or a flat stack of layers, bottom to top.

**Layer**:
One picture in a frame (a canvas, RGBA bytes or a GPU texture), with its alpha and, optionally,
a depth per pixel.

**Capability**:
An optional member of a source (`inspect`, `pick`, `camera`, `audio`, `captions`, `checkpoint`)
that turns on more of the tools. It exists when the member exists.
_Avoid_: feature flag

**Inspect**:
The source's state at `t`, as any JSON the author chooses.

**Source stamp**:
A `source: "file:line:col"` key that the build adds to each object literal with an `id`, so a
value can be traced to the line that made it.
_Avoid_: source map

**Sequential source**:
A source that carries state from frame to frame and so must render its frames in order. It is
the one property a manifest declares.
_Avoid_: stateful source, simulation mode

**Motion blur**:
The picture averaged over several `t` inside a shutter, or over earlier frames a sequential
source keeps. A blur of one frame along a direction is a directional blur, not motion blur.
_Avoid_: temporal blur, shutter blur

**Lookback**:
How many frames before frame f a sequential source's frame f depends on. Opened fresh and
stepped through only those frames, the source gives the same frame f as stepped from frame 0.
_Avoid_: history, window, warm-up

**Checkpoint**:
A copy of a sequential source's state after a frame, so a jump back restores it instead of
replaying from frame 0.

**Manifest**:
`shaderera.json`: the project's entry, size, fps, duration, params, seed and variants. Plain
data the tools read without running code; nothing in it says what a frame shows.
_Avoid_: config, scene file

**Params**:
The few values a person may change without editing code, declared as a JSON Schema in the
manifest.
_Avoid_: props, inputs

**Seed**:
The only randomness a source may use.

**Variant**:
A named output the film is designed for (a size, a length, params), laid out by the film's own
code from that manifest.
_Avoid_: crop, version

### Hosts

**Host**:
What opens a project and calls its source. The **Node host** runs it in a child process, the
**browser host** in a headless Chrome. Both keep the same contract.
_Avoid_: runtime, engine

**Runner**:
The browser host's page and server: the project's own Vite, where the source runs in a Worker.

**Execution boundary**:
What keeps project code away from the tools' own powers (Node's permission model, Chrome's CSP).
It is not a sandbox for hostile code.
_Avoid_: sandbox

**Determinism check**:
Rendering the same times in two orders and comparing the inspect JSON and the pixels. Export
runs it too and refuses a source that fails.

### Versions and output

**Revision**:
A saved copy of the project's files, named by their hash.
_Avoid_: commit, snapshot

**Job**:
A frozen render: a revision, a variant, the full params, the seed, the time window, the delivery
settings and the packages the source runs with. The same job always renders the same file.
_Avoid_: render task, preset

**Requirements**:
`requirements.json`: what the person declared for the film (exact copy, format, craft rules,
timings, placements, locks). Review judges only what it declares.
_Avoid_: rules, spec

**Review**:
Principal frames, a contact sheet and technical checks of a film. It measures everything and
fails only errors and what the requirements declare.
_Avoid_: QA, lint, score

**Delivery**:
The files a job produces for someone else (an mp4, a ProRes mov, a finishing handoff), with
`delivery.json` describing them.
_Avoid_: export (an export is any render to a file)

**Placement**:
Where an output will run (Reels ads, a CTV network, a DOOH screen) and the rules its file must
meet, declared in the requirements.
_Avoid_: platform preset

**Batch**:
Every variant × locale of a film, rendered, reviewed and indexed together by `shaderera deliver`.
_Avoid_: campaign render

**Finishing handoff**:
A delivery as PNG frames, a WAV and `delivery.json`, for an editor or a colourist.
_Avoid_: image sequence export

**Handoff**:
A job frozen with its revision's files and `REPRODUCE.md`, so someone else can render it again.
_Avoid_: archive, bundle

**Plan** and **chunk**:
A plan splits a job into chunks of whole frames, each rendered anywhere and then assembled into
one file that equals a single render.

**Bake**:
Frames a film reads that were made outside the host by a command the manifest declares, from
declared inputs. `shaderera bake` makes and stamps them; every command that renders refuses a bake
whose inputs or frames changed since its stamp.
_Avoid_: cache (`io.cache` is derived bytes the host makes itself), render pass

**Preroll**:
Whole frames before a delivery's first frame (black, or the film at negative times), for a
broadcast slate. The film's `t = 0` does not move.

**Analysis artifact**:
Measurements of a footage, image or audio file (`shaderera.analysis/1`), made once by an
analyser and read by the film as data.

**Analyser**:
A script run apart from rendering that measures a file and writes an analysis artifact: ffmpeg,
a music analysis, a model the person downloads. Each one is optional; core runs none.
_Avoid_: adapter (the GPU's word), detector

**Region**:
A named area of an image in an analysis artifact: its mask, its box, its centre, and the region
that holds it (an eye's head).
_Avoid_: segment, selection, object, matte

**Provenance record**:
Where one file from outside the project came from (`shaderera.provenance/1`): its source page,
licence, author, the segment used, the credit shown on screen and the file's sha256. Written
when the file arrives, by the `asset-provenance` plugin; the film never reads it.
_Avoid_: source (what a project's entry returns), catalog, metadata

### Plugins

**Plugin**:
Code that earlier films proved, of one type: a **package plugin** (type `extension`, an npm
package the project imports), a **component** (code copied in), a **preset** (data only) or
**media** (fonts, sound, models, images). Once copied in, it is the project's own. Plugins come
from a folder or the URL of one (`--from`, `SHADERERA_PLUGINS`), else Shaderera's own at
`https://shaderera.com/r`, built from `packages/plugins/` in this repository, MIT. Not the
Claude Code plugin, which installs the agent skills. Called _item_ in code.
_Avoid_: add-on, registry item, template, asset pack, library, catalog

**Label**:
`shaderera.item.json`: a plugin's name, type, tags, licence and `requires`. It is for finding
plugins and resolving requirements only; no host reads it to render.
_Avoid_: metadata, manifest

**Plumbing plugin**:
A plugin that carries no taste (music analysis, three.js on the host GPU, image decoding). An
agent may add one without being asked. Every other plugin is added only when the person asks.
