# 2d-title fixture

An engineering fixture for the CLI's tests, not a showcase. 1080×1350 portrait, 30 fps, 4 s, Canvas2D only.

**Exercises:** a Latin headline, a Thai subtitle wrapped at `Intl.Segmenter('th')` word breaks, an accent rule and a caption. Each is a literal with `id`, `space: 'screen'`, `x`, `y`, `size`, `color`, `text` and `at`, and enters at its `at` with a smoothstep (fade plus a 40 px rise), then holds.

- `inspect(t)` returns `elements`: each literal spread (so it keeps its stamped `source`), plus `opacity`, the wrapped `lines` and the measured `box` `[x, y, w, h]` at t.
- `pick(t, x, y)` hit-tests the boxes of visible elements, top-most first, and returns `{ id }` with no point.
- params: `accent` (colour of the rule, default `#ff7a45`) and `pace` (0.5–2, default 1). The entrance lasts `0.8 / pace` s, so a higher pace is faster.
- The fonts are Noto Sans and Noto Sans Thai (OFL, `src/assets/fonts/OFL.txt`), loaded in `open` through `io.font`.

**Run:** `shaderera check --times 10`, `shaderera inspect --time 2`, `shaderera render`. `apps/cli/src/camera/fixtures.it.ts` checks that a pick at the headline box's centre returns `headline`.
