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
- An injected clock makes a page's motion exact. GSAP 3.15.1, motion 12.43.0 and
  @react-spring/web 9.7.5 captured byte-identically across repeats and under 6× CPU throttling on
  Chrome 156, and JS motion matched CSS within 0.33 ms. reanimate's `clock.js` needed three fixes
  first. The libraries' source was read at newer versions (motion 14.9.1, react-spring 10.1.2).
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
   - The kind, and the still mode's `reference-style` kind, are specified in core's
     [analysis.md](../analysis.md). Reader components implement that spec and do not define it.
   - Each track is one element's one channel (x, y, width, height, opacity, rotation, scale, and
     any other) sampled at source time, with its unit (`css-px`, `source-px`, `deg`, `ratio`, and
     any other) and the source's frame size and pixel ratio. Channels and units are open sets: a
     colour channel names its space (for example `srgb`), and its value may be a vector.
   - A reader keeps channels, units and fields it does not know, and refuses only a wrong format
     or kind.
   - What the source itself declares (a page's keyframes and easing strings, a Lottie file's
     keyframes) is kept as declared, beside the samples, never re-derived from them.
   - Every analyser that measures motion writes this kind: the web capture first, a video
     tracker later. A film reads every measured source the same way, through one reader
     component.
   - A new incompatible layout gets a new kind or format number, as
     [analysis.md](../analysis.md) says.
3. **Capturing a web page is a plugin, not core.** It is an analyser: a script the person runs,
   apart from rendering (analysis.md). It runs in the person's own Chrome, in new headless, with
   a throwaway profile, never the project's `.shaderera/chrome`.
   - **Time** comes from a clock injected before any page script (ported from reanimate's
     `clock.js`, MIT, with the three fixes the experiments needed), never from CDP virtual time.
     `rafHz` is a multiple of the capture fps and is required: any multiple is deterministic,
     and a page that steps once per frame (a spring, a lerp, smooth scroll) moves differently at
     each rate, so the person gives the refresh rate the reference was seen at.
   - **What it records:** in `params`, every setting that can change a captured frame
     (analysis.md): the viewport, the device pixel ratio, media emulation (reduced motion, colour
     scheme), the user agent, the locale and time zone, the clock's epoch, the seed, the fps,
     `rafHz`, the launch flags, the scripted inputs with their virtual times, and the tracked
     selectors; and the Chrome version. A default among these exists only for determinism and is
     documented as such. `--disable-smooth-scrolling` is one: the compositor's smooth scroll runs
     on the real clock, so a page's smooth scroll is not captured, and scrolling is scripted at
     virtual times instead.
   - **Its source** is a second `source` form in analysis.md, for a live capture: the URL, the
     date and the sha256 of each response the page loaded. A live page cannot be hashed; its
     responses can. For that form the reader checks only the format and kind, since there is no
     file to re-hash. analysis.md's "Analysis takes files only" is amended to allow it.
   - **Source time** 0 is when the injected clock starts, before the page's first script runs.
   - **Outside requests** to private, link-local and cloud metadata addresses are refused unless
     the person allows local addresses, so a capture cannot reach the machine's network.
   - **Style facts** (boxes, computed styles, the fonts drawn) come from Chrome, in a still mode
     of the same plugin, as kind `reference-style`. The capture records each font's family,
     PostScript name and `src` and does not copy font files; the person gets the font under their
     own licence (0017).
4. **Comparing is core, and it measures only.** `shaderera still --compare-file <video|image>`
   measures the film against a reference: per frame differences, an activity curve, the offset
   that aligns them, the window where each moves, SSIM and per-region scores. It never passes or
   fails a film. A gate is declared in requirements.json, as 0011 point 6 says.
   - Per-region scores read masks in a form that analysis.md defines: its `u8` mask raster, and a
     named list of masks or boxes. `image-regions` conforms to that form; core names no plugin.
     The flag is not `still --region`, which already crops.
   - A reference of another aspect ratio is refused unless the person gives a fit. The fit and
     the scale are recorded in the report.
5. **A file that is the spec is read, not re-derived.** A Lottie file's keyframes are read as
   written (`motion-lottie-read`, #666), and so are a glTF file's animation clips
   (`motion-gltf-clips`, #688: `render-gltf-read` does not read animations today).
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
  or font files.

**How the rule is kept.** Every reference-copying plugin, doc and the skill pointer is audited
against 0011 before it merges (#690). A parameter that changes a frame is required or measured,
and no wording recommends a look.

**Consequences.**
- A copy is as exact as its source allows: declared timing from a page or a Lottie file, samples
  at the capture fps from anything else.
- The reader, the format and the comparison are shared, so a new source (a video tracker, a
  Rive file) adds an analyser and nothing else.
