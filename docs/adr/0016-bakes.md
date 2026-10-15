# 0016: Bakes, frames made outside the host

2026-10-15. Accepted (the owner asked the CTO to decide).

The Wallloom opening film's final picture came from its own pipeline outside Shaderera: a path
tracer through a native denoiser that keeps history, which the Node host cannot start (project
code may not run programs). It wrote one JPEG a frame, and the film read them back with
`io.read`. Nothing tied those frames to the code that made them: `check` passed on stale frames,
and a cache was invalidated by deleting a file by hand.

**Decision.** A **bake** is frames a film reads that were made outside the host, declared in the
manifest (`bakes.<name>`): the command that makes them, the project files they derive from, the
folder they are written to (anywhere: that film's frames had to live on another drive) and how
they are named (`beauty.####.jpg`, from 0).

- `shaderera bake <name>` runs the command in the project folder with the person's rights, the
  same trust as the Vite config or an npm script. A render never runs it.
- When it exits 0, it stamps what it made in `versions/bakes/<name>.json`: the inputs' hash, and
  every frame's size and hash. Inputs that change while it runs are refused.
- Every command that renders checks each declared bake against its stamp before the source opens.
  It refuses one that was never made, was declared differently, has an input that changed, or has
  a frame missing or changed. The refusal names the bake and `shaderera bake <name>`. There is no
  fallback to the old frames (0008: no silent fallback).
- The source reads the frames through `io.bake(name)`: their count, a frame's bytes, or the frame
  decoded as `io.image` decodes. The CLI's process serves them, as it serves `io.video`. So the
  bake's folder becomes readable through that port only, and `io.read` still refuses anything
  outside the project.

Shaderera never knows what the command does. It knows only that the frames derive from those
inputs, and so whether they are still the frames those inputs make.

**Why hash every frame on every open.** A stamp that trusted file times would pass a frame
edited in place. Hashing is about 1 GB/s here, so a few hundred frames cost well under a second,
against renders that take minutes. If films with tens of thousands of large frames make this
the slow part of `check`, a size-and-time shortcut can come then.

**Not built now.** Each item comes back with the evidence named for it.

- **Sequential sources with reset points (parallel segments).** Needs a film whose own history
  (not a bake's) is too slow on one host, with lookback (0015) and chunks not enough.
- **Render resume.** Needs a render that fails late and often enough that redoing it costs more
  than a plan's chunks (`plan`, `render --chunk`), which already resume by chunk.
- **Worker counts from GPU memory.** Needs device errors that `--workers` (now named in the
  failure) does not settle, measured on more than one machine.
- **A GPU lock across processes.** Needs two Shaderera processes fighting over one GPU in real
  work, not in a busy machine's test.
- **A progress file.** Needs an agent that cannot read `render --progress` on stderr.
- **`check --budget`.** Needs a film where `check --times n` with a small n is not enough to keep
  checks short.
- **woff2 fonts.** Needs a font that ships only as woff2. Converting once to TTF works today.
- **Flicker in review.** Needs a measure of flicker that a person agrees with on real films, and
  not only on synthetic ones.
- **Plugins** `review-image-diff`, `review-image-detail`, `render-frame-pipe`,
  `look-atrous-denoise`, `look-vector-motion-blur`, `render-ggx-bsdf`, `motion-wind` and
  `procedural-*`. Each needs a second film that writes the same code. A plugin is code a film
  proved (the plugin guide), and one film proves the need, not the shape. `still --compare`
  covers what `review-image-diff` would have done for that film.
