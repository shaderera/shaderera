# Determinism and execution

What a host does with a source, frame by frame, what a source must do in return, and where
project code runs. This is behaviour, not creative structure: nothing here says what a frame
shows. The types are in [protocol.md](protocol.md); the tests that pin each behaviour are listed
at the end.

## The rule

The same project, params, seed, `t` and size, at `intent: 'final'`, give the same `inspect` JSON
and the same pixels, whatever was rendered before. Exactly, on one host on one machine; across
hosts and GPUs only within a tolerance ([below](#across-hosts-and-gpus)).

## Frame, time, fps, seed

- A film has `frameCount(fps, duration)` frames, indexed from **0**. Frame *i* is at
  `t = i / fps`, computed from the integer, never summed (`frameTimes`, `frameAt`).
- Every host passes `RenderOptions.frame = Math.round(t * fps)`. In check and export `t` is exactly
  `frame / fps`; a preview scrub may ask for a `t` between frames, and `frame` is then the nearest.
- `host.seed` (manifest `seed`, or a job's) is the only randomness a source may use. Per-frame
  randomness derives from the seed and the frame index.
- What decides a frame: the source revision, `manifest` (after the variant), `params`, `seed`,
  frame index, the size, and for the browser host the browser identity. The host records what it
  ran (`delivery.json` `versions.host`, `render`'s `host:` line).

## How `check` measures it

`shaderera check` (and MCP's `check`, and `checkDeterminism` from `@shaderera/core`):

1. **Picks times.** `--samples` frame-aligned timestamps (default 50; 20 over MCP): frame 0, the
   last frame, and seeded picks between.
2. **First pass, ascending.** For each `t`: `render(t, final)`, composited, and the SHA-256 of
   the RGBA bytes; then `inspect(t)` (if the source has it).
3. **Second pass, shuffled** with a seeded PRNG (`--seed`, default 1; never the same order as the
   first). Each `t` is now reached after a different `t`.
4. **Compares.** Any `inspect` difference is reported by `diffJson` path; any hash difference as
   two hashes.
5. **Preview vs final** at three of the times: mean and max channel difference. Reported, not
   failed.

The check stops at the first time that differs. The failure names that time (to the millisecond)
and its frame, what was rendered before it (`rendered first` when nothing was), what changed and
the usual causes, and exits 1:

```
✗ not deterministic: differs at t=2 (frame 60), the first difference found; check stops there
  ✗ t=2 after t=3.9, inspect: title.opacity
  ✗ t=2 after t=3.9, pixels: <first 12 hex> != <first 12 hex>
  Usually Math.random, Date.now or state carried between frames: use host.seed and derive everything from t. See docs/determinism.md.
```

## Export refuses a source that fails

A source that fails the check can play, but it cannot export. Every export (`render`, `deliver`,
MCP's `render`, each chunk of a plan) is also the first pass of a check. Before the file is
finished, its frames on the film's one-a-second grid (frames 0, n, 2n …, n the film's frames a
second, rounded) are rendered again in a shuffled order, with `inspect` compared too. At the
first one that changed, the export stops, no file is left, and the error names the frame and the
one rendered before it:

```
$ shaderera render
shaderera: Not exported: the source is not deterministic (t=0 after t=0.9: pixels).
```

(A captured run on `apps/cli/src/cli/fixtures/stateful`, whose picture counts the frames rendered
before it.) A refused export leaves the previous one at the output, and the error says so, with the
time it was written. For a source that renders any t, the gate costs one render a second of film
(about 3 % at 30 fps), with the params, seed, size and camera of the export; `check` samples the
whole film in two orders. The grid is the film's, not the export's: the whole film and the chunk of
a plan that hold a window (`render --from/--to`) re-check every frame the window re-checks, so the
two never disagree about a frame because one of them did not look at it. A window shorter than a
second may hold no frame of the grid. An export spread over several hosts (`render --workers`, a
chunk) sends the frames round the hosts, and splits the re-check evenly between them, run at once: a
frame is rendered again on a host other than the one that first rendered it, and each host shuffles
its own share. So the hosts must agree with each other, not only with themselves (with 2 hosts at an
even fps, every frame of the grid was host 0's, so host 0 takes back half of them). Meanwhile the
progress line says `re-checking 12/20`.

A `sequential` source is different: it reaches an earlier frame by replaying from frame 0 (or
from a checkpoint), so each frame re-checked out of order can cost a replay of the film, and one a
second would grow with the square of the film's length. Its re-check is 8 frames of the grid at
most, spread evenly over the window: a fixed cost of up to 8 replays. So for a sequential source
the window guarantee is weaker: a longer range, or a chunk, may not re-check a frame a window
inside it re-checks, and `check` is what covers the rest.

## What breaks it, and the fix

| Cause | Symptom | Fix |
|---|---|---|
| A clock: `Date.now()`, `new Date()`, `performance.now()`, `requestAnimationFrame` | every `t` differs | compute from `t`. Both hosts count those reads inside `render`; `check`, `still` and `render` warn with the count (`delivery.json` records it). Counted, never blocked, since a library may read the clock only to log |
| A second Dawn: a library that installs its own `webgpu` | the process crashes later, at random | the Node host refuses the second `dawn.node` as it loads, naming both paths. Give the library `host.gpu` ([webgpu.md](participants/webgpu.md)) and keep one `webgpu`; `shaderera doctor` lists the copies |
| `Math.random()` | differs on every call | a seeded PRNG built from `host.seed` (and the frame, if per frame). Calling it once while building objects in `open` is fine; in `render` it is not |
| State carried between calls (`x += velocity`, an accumulator, a cache keyed by the previous frame) | passes ascending, fails shuffled | derive state from `t` alone (`rotation.y = t * 0.6`, not `+= dt * 0.6`), or declare `sequential` |
| A progressive renderer that keeps accumulation across `t` | `final` depends on history | reset accumulation when `t` or the camera changes, at least for `intent: 'final'` |
| An async race (a font or texture still loading) | first frames differ | await everything in `open` |

Keep one pure `state(t)` or `place(t)` that `render`, `inspect`, `pick` and `camera.get` all
call, so what is inspected is what was drawn.

### Canvas2D at `'high'` keeps a trace of what it draws over

`imageSmoothingQuality` picks the filter, so `'low'`, `'medium'` and `'high'` draw different
pixels. At `'low'` and `'medium'` an opaque picture drawn scaled covers what was under it. At
`'high'` it does not quite: with `@napi-rs/canvas` 1.0.10 (the Node host), the scaled picture's
alpha comes out a hair under 1 inside Skia, so a draw with the default `source-over` keeps a
trace of the canvas's old pixels, up to 1 in a channel. A canvas kept across frames still holds the
previous frame, so the frame depends on which t came before it: `still` alone and after another t
differ, and the export's re-check refuses it. A picture drawn up from 192 px to 1280×720 over a
white canvas and over a clear one differs in about 52 000 bytes, each by 1; at `'low'` and
`'medium'`, in none.

Draw at `'high'` over a known background each frame: `clearRect` (or fill) the canvas first, or
draw with `globalCompositeOperation = 'copy'`: then the same picture gives the same pixels
whatever the canvas held. The host does not clear a film's canvases for it, since a canvas drawn
once in `open` and kept is the film's to keep.

## Pure and sequential sources

A source is **pure** unless its manifest says `"sequential": true`. A pure `render(t)` depends
only on the inputs above; the host calls it at any frame, in any order, as often as it likes. A
frame that only needs samples of its own `t` (noise seeded by pixel and sample, not by frame)
stays pure and renders in parallel.

A **sequential** source carries state from frame to frame (a simulation, a feedback trail, a path
tracer's temporal samples, generator-based animation). `render(t)` alone cannot reconstruct it,
and the host never pretends it can:

1. **Frame zero.** The state right after `open` is the state before frame 0. Initialisation and any
   pre-roll (warm-up steps before the first visible frame) happen in `open`, from the inputs alone.
   No public pre-roll field exists.
2. **Fixed steps.** The source advances its state once per `render` call, by the frame's fixed
   `dt = 1 / fps` (or its own fixed substeps within it), counting with `options.frame`. Never by a
   wall clock, never by the distance between two `t`.
3. **Order.** The host (`seekable` in `@shaderera/core/host`) hands it frames 0, 1, 2… in order.
   To reach frame *n* it renders every skipped frame at `intent: 'preview'` first.
4. **Intent independence.** The state after a frame must not depend on `intent`. A preview may draw
   coarser pixels, but it steps the simulation exactly as a final render.
5. **Seeking back** (or rendering the same frame again): the host restores the latest checkpoint at
   or before the frame and steps on, or, without one, disposes the source, opens it again and
   replays from frame 0 (from *f* − k with a [lookback](#lookback)). Looping is a seek back to
   frame 0.
6. **Inspection is aligned.** `inspect`, `pick` and `camera.get` at *t* answer about the state after
   frame *t*: the host brings the source through frame *t* first.

Export from frame 0 is correct; scrubbing costs more, and export renders a sequential source on
one worker (`plan` and `render --chunk` split it, each chunk reaching its first frame as a seek). A source that keeps state without declaring `sequential` is caught by the check (two
orders) and cannot export. There is no silent fallback.

## Lookback

`"sequential": 8` says frame *f* depends only on the 8 frames before it: opened fresh and stepped
through frames *f* − 8 … *f* − 1, the source gives the same frame *f* as stepped from frame 0. For
a path tracer that reuses earlier frames' samples, a trail, a motion blur over past frames.

- **Fresh starts.** On its first render, on a jump back and at the start of a chunk, the host
  opens the source and steps from *f* − 8, not from frame 0. A jump forward still steps every frame
  between, and checkpoints still apply.
- **The state must be a window.** Keep the last 8 frames (a ring), never an average that decays:
  an exponential average still carries a trace of frame 0, so frame *f* differs by how it was
  reached.
- **The check catches a wrong lookback.** In the ascending pass a frame comes after every frame
  since the first; in the shuffled pass a jump back gives it only 8. A source that remembers more
  than it declared differs between the two and fails, as export does.
- **Warm-up frames render at `preview`**, so intent independence holds as before: the frames that
  feed the window take the same samples at both intents.

## Checkpoints

The optional `checkpoint: { save(), restore(state) }` of a sequential source.

- **Ownership.** The source owns the state and its serialisation. `save()` returns plain data
  (anything structured clone copies: typed arrays, objects), the state after the frame it rendered
  last. GPU handles are not state: a GPU source reads its buffers and textures back
  (`@shaderera/core/gpu` helps) and `restore` writes them into its own resources.
- **Portability.** `restore` must work on any instance opened with the same inputs, not only on
  the one that saved.
- **When.** The host saves after a frame once 250 ms of rendering has passed since the last
  checkpoint, so a cheap simulation keeps none (replay is cheaper than readback) and an expensive
  one keeps them spaced by cost. At 32, every other one goes and the spacing doubles.
- **Invalidation.** A checkpoint is keyed by the inputs the source was opened with (manifest,
  params, seed) and the free camera, and restored only under the same key. Checkpoints live in
  memory for one opened source and are dropped on dispose; they are never persisted or shared
  across processes.
- **Failure.** A `save` or `restore` that throws fails the call with the frame named. The host does
  not fall back to some other state.

## Readiness, failure, cancellation, disposal

- **Readiness.** Everything asynchronous happens in `open` (fonts, images, models, pipelines). A DOM
  (`manifest.dom`, browser host) is checked at every capture: a font face that failed to load, an
  `<img>` that did not load, or a `<video>` with no frame at its time fails the capture with its
  name. CSS background images are not checked.
- **Settling.** A DOM is drawn until two snapshots in a row agree. If 7 in a row differ (something
  moves on its own clock, or is still loading) the capture fails; it is never accepted.
- **Unsupported capture.** A browser without HTML-in-Canvas (`drawElementImage`) fails at open,
  before any frame, with the flag to set.
- **Host.** `shaderera.json` `host` is the host every tool opens (check, render, review, inspect,
  still, deliver, MCP and jobs). A job's first render pins the host it ran on
  (`versions/jobs/<name>.host.json`); another host is refused. A saved revision's entry and DOM
  both come from its frozen copy.
- **Timeouts.** Every call to the source is bounded by `--timeout`; in the browser host every
  DevTools call is, and on expiry Chrome is closed, so later calls fail rather than wait.
- **Device loss.** A lost WebGPU device fails the call it happened in (never returns its frame);
  the next call reopens the source on a new device, in both hosts. A sequential source restarts.
- **Failed step.** If a render throws, the source's state is unknown: the next call restores a
  checkpoint or reopens, never continues from it. An export that meets a failure leaves no file.
- **Cancellation.** A preview render superseded by a newer one is aborted (`options.signal`); for a
  sequential source it counts as a failed step.
- **Disposal.** `dispose` releases the source's resources; the host calls it on reopen and close.
  After dispose the wrapped source refuses calls.

## Pixels

A frame is a flat stack composited `over` (depth-tested where layers carry depth); raw bytes
declare `straight`, `premultiplied` or `opaque`. Both hosts return straight RGBA; a PNG keeps it
byte for byte, and an mp4 shows it matted over black. Output is 8-bit sRGB, display-referred
(16 bits for a master where the GPU composites). A film that opts in delivers HDR10
([delivery.md](delivery.md#hdr10)); scene-linear light stays inside a renderer
([delivery.md](delivery.md#higher-precision-scene-linear-exr-aovs)).

A host with a GPU composites on it: the browser host, and the Node host of a project with
`webgpu`. It works in floats, so a byte may differ by 1–2 from the CPU's `over`. Without a GPU,
the Node host composites with Skia, or with JS `over` where a layer has depth. For an mp4 the GPU
host mattes the frame over black and converts it to Y'CbCr 4:2:0 (BT.709 matrix, limited range)
itself; the export's determinism hashes are then taken on those bytes.

## Across hosts and GPUs

Equality is exact (SHA-256 of the RGBA frame) **within one host on one machine**: same host kind,
browser build, GPU and driver. So `check` is exact within one host. **Export a film from one
host**: do not cut frames from the browser into a Node export, or compare them expecting equality.

Canvas2D layout is portable and its pixels are not: shaping, fallback and line breaks match
between Chrome and Node, glyph edges and gradients do not ([canvas.md](participants/canvas.md#measured-browser-vs-node)).
WebGPU content can match. A hybrid film (1280×720) was compared at four times, Chrome 154's WebGPU
against Dawn (`webgpu@0.6.2`) on one machine (RTX 5070 Ti, Windows 11), with `diffPixels` at
threshold 0, both compositing on the CPU:

| t | Shot (technologies) | Differing pixels | Mean | Max |
|---|---|---|---|---|
| 1 | Canvas2D headline (Latin + Thai) | 481,854 / 921,600 (52.28%) | 0.581 | 216 |
| 3 | LinearWipe (WGSL on `host.gpu`) between the headline card and the 3D shot | 73,481 (7.97%) | 0.046 | 144 |
| 5 | three.js `WebGPURenderer` + Glyph world-space type in one pass | **0 (0.00%)** | 0 | 0 |
| 8.5 | the 3D shot + the Canvas2D CTA on top | 4,640 (0.50%) | 0.043 | 171 |

That was one machine and one source, not a guarantee for every GPU or driver. Across GPUs a
chaotic simulation diverges, and the specs allow it: WGSL sets no rounding mode and lets an
implementation reassociate and fuse operations (WGSL §15.7), multisample positions are
implementation-defined, and atomics are relaxed, so float atomics accumulate in an order-dependent
way (WGSL §17.8; use fixed-point integer atomics for an order-free sum). There is no realtime
frame-rate promise for arbitrary sources: a React card used as a texture in a WebGPU scene costs
about 270 ms a frame.

## Where project code runs

> **Shaderera has an execution boundary, not a sandbox.** It keeps project code away from the
> tools' own powers. It does **not** make hostile code safe to run. Run only projects you would
> run with `npm run build`.

Every host builds or serves the project with its own Vite config, in the `shaderera` process.
That config and its plugins are project code, and they run with your rights in both hosts.

**The Node host** (the default). The CLI builds the entry into `.shaderera/node/<pid>-<n>/` and
opens it in a child process started with Node's permission model:

- read access to the project and the `node_modules` folders that hold the packages the host loads
  (npm installs a native addon's platform package beside it, so the whole folder is needed);
- `--allow-addons`, because Dawn and `@napi-rs/canvas` are native addons;
- no file writes, no child processes, no stdin; its stdout and stderr go to the parent's stderr,
  so project output never mixes with a command's result or MCP's stream.

The parent writes the output file and runs ffmpeg. Every project file the parent reads or writes
must resolve inside the project, with symbolic links followed: MCP's `get_source` and `render`
output, and the host's `io.read` and `io.font`. It does not stop: network access (Node 24's
permission model does not cover it); reads by the source's own `fs` calls through a symbolic link
inside the project (Node's permission model follows links); any installed native addon, which runs
with your rights. `--trusted` drops the permission flags; trust is given by the person running the
command, never declared by the project.

**The browser host** (`"host": "browser"`, or `--host browser`):

- The CLI starts the runner (the project's own Vite, on `127.0.0.1`) and a headless Chrome of your
  own install (`CHROME` overrides the path; none is bundled), and drives it over the DevTools
  protocol. Chrome uses the project's own profile (`<root>/.shaderera/chrome`, or a throwaway one
  when another host holds it), never yours, and keeps its own sandbox.
- The source runs in a Worker on the runner page; the project's DOM is laid out on the page.
- The runner sends a strict Content-Security-Policy: scripts and connections only to itself,
  WebAssembly allowed, and `frame-ancestors 'none'`. Project code cannot send data to other hosts.
- Frames come back as POSTs to the runner server, which takes only a key the host is waiting for
  and refuses anything else unread.

It does not stop: reading any file the runner's Vite serves (its `fs.allow`: the workspace root
and the shaderera package), though not sending it anywhere; a malicious dependency at install
time; another local process connecting to the DevTools port on loopback while it runs. Node's
permission model does not apply here, and `--trusted` changes nothing.

SES or a stronger isolation model returns when a hosted Shaderera opens projects their viewer did
not write. SES is not used now because its compartments make `Math.random()` and `Date.now()`
throw, and libraries such as three.js call `Math.random()` while building objects.

## Tests

| Behaviour | Test |
|---|---|
| Sequential/direct/backward/loop/reset agree; checkpoint restore and invalidation; spacing cap; failed and cancelled steps; restore failure; plain-data checkpoints; off-grid t; frame 0; dispose | `packages/core/src/sequential.test.ts` |
| The same on a real GPU source (Dawn): sequential, direct (fresh process), backward, loop, export; preview steps state as final; seeds | `apps/cli/src/node/particles.it.ts` |
| Replay in the Node host | `apps/cli/src/node/sequential.test.ts` |
| DOM capture: settled and repeatable; unsettled, missing image and missing font fail; host identity; a hung call times out; a browser job renders its frozen DOM; size override | `apps/cli/src/node/dom.it.ts` |
| Straight RGBA in both hosts, PNG byte for byte, mp4 matted over black | `apps/cli/src/node/pixels.it.ts` |
| Export refuses a non-deterministic source and leaves no file | `apps/cli/src/cli/render.test.ts`, `deliver/finishing.test.ts` |
