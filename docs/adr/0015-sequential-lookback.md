# 0015: A sequential source may declare its lookback

2026-10-14. Accepted (the owner asked the CTO to decide).

A path tracer that reuses earlier frames' samples had to choose between pure (random access,
parallel chunks, no history) and `sequential` (history, but every seek replays from frame 0), so
it stayed pure with a spatial-only denoiser (the Wallloom framing film, its gap 2).

**Decision.** `sequential` in the manifest is `true` or a positive whole number of frames, the
source's lookback k. With a lookback, the host starts a fresh source at frame f − k instead of
frame 0: on the first render, on a jump back, and at the start of a chunk. A jump forward still
steps every frame in between.

**Why a jump forward steps.** So that `check` compares two different histories: in the
ascending pass a frame comes after every frame since the first, and in the shuffled pass some
come after only k. A source whose state reaches further back than it declared (an exponential
average instead of a ring of k frames) then fails `check`, not the end of a long export.

**Unchanged.** Skipped frames render at `preview`, so the state must still not depend on intent:
a path tracer's history takes the same samples at both. Export stays on one host; `plan` and
`render --chunk` give the parallelism, k frames of warm-up per chunk. No compatibility shape: in
0.x, `sequential: true` simply keeps its meaning.
