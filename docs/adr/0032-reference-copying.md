# 0032: Reference copying, measured and never reduced

2026-11-04. Proposed; waits for the owner.

**Context.** People ask for a film that matches a reference one to one: a clip, a live web page,
a Lottie file, a poster from a designer, a website's hero. The tool they use today,
[reanimate](https://github.com/NiazMorshed2007/reanimate) (MIT), has too much taste for that:
- it reduces what it measures to named easings (`expo.out`), fitted springs and pattern tables
  with typical numbers;
- it passes or fails a copy on thresholds it sets itself (±80 ms, 2 % of pixels);
- for a video it tracks nothing: the agent reads frames by eye and guesses the easing.

Two research notes and six experiments
([reference-motion-capture.md](../research/reference-motion-capture.md),
[reference-still-capture.md](../research/reference-still-capture.md)) found:
- An injected clock makes a page's motion exact. GSAP, motion and react-spring captured
  byte-identically across repeats and under 6× CPU throttling, and JS motion matched CSS within
  0.33 ms. reanimate's `clock.js` needed three fixes first.
- CDP virtual time is accepted by Chrome 156 in new headless, but its frame timing is unusable:
  rAF ran every 16.6 ms in one run and 33.4 ms in the next, and a throttled run hung.
- Chrome already knows a page's exact style facts: `DOMSnapshot.captureSnapshot` and
  `CSS.getPlatformFontsForNode` give boxes, styles and the font each run was drawn with.
- From an image, text layout is a guess (OCR), and font identification is unreliable: the best
  open model reaches about 49 % top-1 and has no Thai.

**Decision.**

1. **A reference is measured into frozen data, and the film reads the data.** Copying is
   plumbing under [0011](0011-experts-and-agents-no-taste-lock.md): what is measured is kept as
   measured. Nothing reduces a curve to a named easing, a spring or a pattern as the thing a film
   builds from. A named fit may be reported next to the samples, as information only.
2. **One format for sampled motion:** `shaderera.analysis/1`, kind `reference-tracks`.
   - Each track is one element's one channel (x, y, width, height, opacity, rotation, scale, and
     any other) sampled at source time, with its unit (`css-px`, `source-px`, `deg`, `ratio`) and
     the source's frame size and pixel ratio.
   - What the source itself declares (a page's keyframes and easing strings, a Lottie file's
     keyframes) is kept as declared, beside the samples, never re-derived from them.
   - Every analyser that measures motion writes this kind: the web capture first, a video
     tracker later. A film reads every source the same way, through one reader component.
   - A new incompatible layout gets a new kind or format number, as
     [analysis.md](../analysis.md) says.
3. **Capturing a web page is a plugin, not core.** It is an analyser: a script the person runs,
   apart from rendering (analysis.md). It runs in the person's own Chrome, in new headless, with
   a throwaway profile, never the project's `.shaderera/chrome`.
   - **Time** comes from a clock injected before any page script (ported from reanimate's
     `clock.js`, MIT, with the three fixes the experiments needed), never from CDP virtual time.
     `rafHz` is a multiple of the capture fps, by default equal to it.
   - **What it records:** the URL, the date, the viewport, the seed, the fps, `rafHz`, the Chrome
     version and the sha256 of every response the page loaded. A live page cannot be hashed;
     its responses can.
   - **Outside requests** to private, link-local and cloud metadata addresses are refused unless
     the person allows local addresses, so a capture cannot reach the machine's network.
   - **Style facts** (boxes, computed styles, the fonts drawn) come from Chrome, in a still mode
     of the same plugin. Font files are never copied: a site's web font is licensed to that site.
4. **Comparing is core, and it measures only.** `shaderera still --compare-file <video|image>`
   measures the film against a reference: per frame differences, an activity curve, the offset
   that aligns them, the window where each moves, SSIM and per-region scores. It never passes or
   fails a film. A gate is declared in requirements.json, as 0011 point 6 says.
5. **A file that is the spec is read, not re-derived.** A Lottie file's keyframes are read as
   written (`motion-lottie-read`); a glTF clip is played as it is.
6. **The workflow is a guide, not a skill.** `guides/reference-motion.md` holds the loop (scope,
   capture, spec, build, compare, fix one cause), the pitfalls and the rights. The `shaderera`
   skill points to it only when the person hands over a reference.
7. **Rights are the person's call** ([0017](0017-outside-media.md)). A reference file is
   recorded through `asset-provenance` as supplied by the person. The guide says what the
   sources say: Pinterest forbids scraping, a typeface and a general layout are not registrable
   in the US, a poster's artwork and copy are.

**Waiting for evidence, not rejected.**
- **Text layout from an image** (PaddleOCR PP-OCRv5, Apple Vision on macOS): after a benchmark
  on real Thai posters labelled by hand.
- **Tracking elements in a video:** after a benchmark of trackers on screen recordings labelled by
  hand. No published study covers UI footage.
- **Canvas and WebGL channels of a page,** and registration of a photographed poster: when a film
  needs them.

**Not built.**
- CDP virtual time, and `HeadlessExperimental.beginFrame` (headless shell only, never macOS).
- Default fidelity levels and thresholds, pattern tables with typical numbers, and easing tables
  that turn a measurement into a library's preset.
- Guessing a font from an image. The agent can render candidates the person picked and measure
  them.
- Fetching from Pinterest or any site that refuses scripts, and copying a page's shaders, models
  or fonts by default.

**Consequences.**
- A copy is as exact as its source allows: declared timing from a page or a Lottie file, samples
  at the capture fps from anything else.
- The reader, the format and the comparison are shared, so a new source (a video tracker, a
  Rive file) adds an analyser and nothing else.
