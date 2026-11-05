# Copying a reference

For requests where the person hands over a reference to match one to one: a clip or screen
recording, a live web page, a Lottie file, a poster, a screenshot or a website's hero.

The reference and the person decide how the copy looks and how close is close enough. The tools
here measure and never judge: no command passes or fails a copy, and none names an easing, a
preset or a threshold. `docs/` below is `node_modules/shaderera/docs/`; a plugin's README is
printed by `npx shaderera info <name>`.

## The loop

1. **Scope.** Write down in `DIRECTION.md` which part of the reference is copied: the elements,
   the properties, the span of time (from which input or moment, to when), the frame size, and
   what the film adds or leaves out. Note what does not move as well as what does.
2. **Capture.** Measure the reference into files the film reads, from the most exact source it
   has (the next section). Record the reference with `asset-provenance` when it arrives
   ([Rights](#rights)).
3. **Spec.** Fill the [spec table](#the-spec-table) from the captured files: one row per element
   and property, with the source of every number.
4. **Build.** The film reads the measured data (a Lottie file's keys, a capture's tracks or
   declared keyframes) and maps its own time to the source's. A number copied by hand into the
   code is a row of the table with its source named.
5. **Compare.** `npx shaderera still --compare-file <clip or image>` ([Compare](#compare)), and
   look at the sheets it writes every round, not only the numbers.
6. **Fix one cause.** Find the cause of the largest difference (an offset in time, a scale, a
   font, a position, a colour), change that alone, and compare again, so each round's numbers say
   what the change did.

Repeat from 5 (or from 2 when the capture was wrong). The loop ends when the person says so, or
when no cause is left that the film can fix: then report what still differs, with the numbers
and the times and regions where it is. Changing the measurement (a smaller `--region`, a higher
`--floor`, a shorter span) changes what is measured, not the copy: say so when you do it.

## Which source gives what

Most exact first. Use the most exact one the reference has, and say in the table which one each
number came from.

| Source | What it gives | How |
|---|---|---|
| A Lottie file | the spec itself: frame rate, in and out points, layers, each transform property's keys, holds and bezier handles, as written | `npx shaderera add motion-lottie-read`; `loadLottie` reads it, `valueAt(property, t)` plays a property with the file's own curves. What it does not read (shapes, masks, expressions, effects, …) is listed in `unsupported`, by where it is |
| A glTF file with animation clips | the spec itself: its clips' channels, key times, values and interpolation, as written | `npx shaderera add motion-gltf-clips`; `loadClips` reads them, `valueAt(channel, t)` plays a channel by the glTF spec (STEP, LINEAR with slerp, CUBICSPLINE). Skins and morph targets are reported as present, not applied |
| A web page, motion in CSS or the Web Animations API | the page's own keyframes and timing, exact at any time | `analysis-web-capture`: `declared` in `tracks.json`, each animation's `keyframes` and `timing` as Chrome returns them, never fitted |
| A web page, any motion (JavaScript too) | each tracked element's box, transform and opacity, and the window's scroll, sampled at the capture's fps | `analysis-web-capture`: `tracks` in `tracks.json`, read through `analysis-reference-tracks` (`loadTracks`, `track`, `at`). Exact on the captured frames; between them `at()` reads `hold` or `linear`, and any other reading of the samples is the film's own code |
| A web page at one moment | every element's box and computed styles, each text node's line boxes and the fonts Chrome drew it with, and a screenshot | `analysis-web-capture` with `--still <ms>`: `style.json` and `style.png`, read with `loadStyle`, `styleOf`, `textsOf` |
| A clip (a video, a screen recording, a GIF) | its frames: no tool tracks its elements | `--compare-file <video>` measures timing (each side's activity, the offset that aligns them, where each moves) and the difference per frame; positions are read from its frames by eye, at its frame rate |
| An image (a poster, a screenshot) | its pixels | `--compare-file <image>`, region by region with `--regions`. No tool reads text, layout or fonts from an image: which font it is, is the person's to say |

### A web page

```sh
npx shaderera add analysis-web-capture        # analysis-reference-tracks comes with it
node tools/capture-web.ts https://example.com/ --out references/hero \
  --track '.hero h1' --track '.hero .card' --fps 30 --rafHz 60 --duration 3 --viewport 1280x720
node tools/capture-web.ts https://example.com/ --out references/menu \
  --track '.menu' --fps 60 --rafHz 60 --duration 2 --viewport 1280x720 \
  --trigger click --target '.menu-button' --at 500
node tools/capture-web.ts https://example.com/ --out references/hero-look \
  --still 1500 --rafHz 60 --viewport 1280x720 --root '.hero'
```

The selectors, times, rates and sizes above are placeholders: give the reference's own.

- `--fps`, `--rafHz`, `--duration` and `--viewport` have no defaults: each changes every sample.
  Neither do a trigger's `--target`, `--at`, `--scroll-to` and `--scroll-ms`. `--rafHz` is how
  often the page's `requestAnimationFrame` runs, a whole multiple of the fps: a page that steps
  its motion once per frame moves differently at each, so give the refresh rate the reference was
  seen at.
- The capture's other settings have defaults so that two runs on two machines repeat, never your
  OS's settings: `--seed 1`, `--dpr 1`, `--media prefers-color-scheme=light` and
  `prefers-reduced-motion=no-preference`, `--locale en-US`, `--timezone UTC`, `--time-origin 0`,
  `--clock-date 2000-01-01T00:00:00.000Z`. Each is recorded in the file (`params`,
  `frame.pixelRatio`). They also pick which variant of the page is captured (its light,
  full-motion, 1x, English one): pass the values the reference was seen with. Fixed, and recorded
  too: a desktop page (`params.mobile`), hidden scrollbars and videos let autoplay
  (`tool.chromeFlags`).
- `--settle load` and `--trigger load` are defaults as well, recorded in `params`: the clock
  freezes at the page's first script (`--settle loaded`: at its load event), and the motion starts
  with the page (`--trigger click`, `hover`, `leave` or `scroll`: from an input at `--at`). They
  decide which moment of the page is captured: pass the ones that match how the reference was
  seen.
- Run it twice, once with `--cpu-throttle 6`. The files must differ only in `source.date` (with
  `--settle loaded`, also in what the load did on real time). If the tracks change, the page reads
  a clock the capture does not hold.
- Read `limits` in the file before building on a capture: what it could not make exact, each
  with where and why. Canvas and WebGL drawing has no channel; a still shows it in its screenshot
  only.

Every flag is in the plugin's README, and the file's fields are in `docs/analysis.md`.

### A Lottie file

`motion-lottie-read` reads keys as written and plays them as a player does. Units are Lottie's
(position in the file's pixels, scale in percent, opacity 0 to 100): converting them to the
film's frame is the film's code. A dotLottie (`.lottie`) archive is refused: unzip it and read its
`animations/<name>.json`.

## The spec table

One row per element and property. Every number has a source; one without a source is a guess,
and the table says so.

| Element | Property | Values | Start | End | Easing | Source |
|---|---|---|---|---|---|---|
| `.hero h1` | `translateY` | the track | the track | the track | sampled | `references/hero/tracks.json`, 30 fps |
| `.card` | `opacity` | from the keyframes | from `start` and `timing` | from `start` and `timing` | each keyframe's `easing`, as written | `declared` in `references/hero/tracks.json` |
| `Card` layer | `p` | the keys | the first key | the last key | each key's handles | `assets/intro.json` |
| logo | `scale` | read from two frames | read | read | unknown | the clip's frames, by eye |
| background | none: holds | | | | | the clip's frames |

- **Easing** is what the source gives: the declared string or the file's handles as written, or
  `sampled` when the film reads the track itself. A curve that only samples show is never named
  after a preset.
- **Time** is the source's: frame 0 of a capture is when its clock froze, and a Lottie file's t is
  its frame over its frame rate. The offset from the film's time is a column of its own when it
  differs per row.
- Rows that hold still belong in the table: a film that moves what the reference keeps still
  shows up in the compare's motion window.

## Compare

```sh
npx shaderera still --compare-file references/hero.mp4 --sheet
npx shaderera still --compare-file references/hero.mp4 --offset=<s> --floor <level> --sheet --json
npx shaderera still 1.5 --compare-file references/hero-look/style.png --regions references/hero-boxes.json
```

- **A clip:** per time, PSNR, the mean and largest ΔE and each side's activity (the mean change
  from the time before), the shift that best aligns the two activity curves (printed as
  `Aligned: --offset=<s>`), and each side's motion window. With no times given, the clip's own
  frames are measured.
- **An image:** per time, PSNR, ΔE, SSIM on luma and the edge score, for the whole frame and for
  each region of `--regions`. An image of another shape than the film's frame is refused unless
  `--fit stretch` is given.
- Each time writes the film, the reference and their difference (an SSIM heat map for an image)
  side by side, and `--sheet` puts them on one sheet. Through MCP, `still` with `compare_file`.
- There is no pass or fail, and the exit code is 0 unless an input is bad. Every field is in
  `docs/cli.md`, "Measuring against a reference clip" and "Measuring against a reference image".

## Pitfalls

- **The same viewport, crop, fps and trigger on both sides.** A capture's `--viewport` is in CSS
  pixels and its tracks are from the viewport's top left; the film's frame is in its own pixels.
  A trigger's time (`params.trigger.at`, in milliseconds) is in source time: the film's input, a click or a
  scroll, happens at that time plus the film's offset. A clip of another size is scaled to the
  film's frame (`scaled` in the report, `aspect: "stretched"` when the shapes differ), which moves
  every edge.
- **Crop cursors and browser chrome out of a recording.** The tab bar, the address bar and the
  pointer are pixels the film does not draw, and a moving pointer adds to the clip's activity,
  so the offset found can follow the pointer. Crop the recording to the page once
  (`ffmpeg -i in.mp4 -vf crop=<w>:<h>:<x>:<y> out.mp4`), or measure a `--region`.
- **Retina scale.** A screenshot or recording on a display with a device pixel ratio of 2 has
  twice the CSS pixels each way. Tracks are in `css-px`; `frame.pixelRatio` and `--dpr` say the
  ratio. Convert to the film's frame in the film.
- **A GIF's timing is good to about one frame.** GIF stores each frame's delay in hundredths of a
  second, and Chrome and Firefox play a delay of 0 or 1 hundredth as a tenth. `--compare-file` refuses a
  clip whose frames are not at a constant rate, naming the frame; `docs/cli.md` gives the
  ffmpeg line that re-encodes it to one.
- **A font fallback changes every pixel.** A missing font, or one missing a glyph, is replaced by
  another whose shapes and advances differ, so every pixel of the line moves and the scores drop
  for the whole line. Check the fonts first: a page's still names the fonts Chrome drew each
  text with (`textsOf(look, …)[i].fonts`, a fallback as a font of its own), and the film draws
  with the font files it loads. Fonts installed on the capturing machine are not recorded.
- **Note what does not move,** as well as what does: the background, a logo that holds, an
  element that stays put while others move. Each is a row of the table.
- **Measure the noise floor by comparing the reference with itself.** Two captures of a page must
  be the same bytes (above). A clip's activity where nothing moves is its codec noise: read it in
  the reference's `activity` in `--json`, and give it as `--floor`. A film that only draws the
  reference clip, compared with that clip, gives what reading and scaling alone change: the floor
  a copy's numbers are read against.
- A negative `--offset` is written `--offset=-0.2`, or it reads as a flag.

## Stills

For a poster, a screenshot or a page at one moment, compare region by region, in this order:
grid and position, then type, then colour. A box in the wrong place changes every pixel it
covers, and a font fallback every pixel of its line, so the colour numbers of a region mean
something once its position and type agree.

- **Regions** are the parts scored apart: boxes with names, written by hand,
  `{ "width": 1080, "height": 1350, "boxes": [{ "name": "title", "x": 80, "y": 120, "width": 900, "height": 200 }] }`,
  in the image's pixels or the film's (which `width` and `height` say); or a regions artifact of
  the image, such as `image-regions` writes. The form is in `docs/analysis.md`, "Regions (still
  image)".
- **SSIM** sees light and structure, not hue: ΔE measures colour. The edge score says whether
  the edges are in the same places; each side's mean edge strength shows a softer line.
- **A page's still** gives the numbers themselves: each element's box, its computed styles
  (`styleOf(look, …).styles`) and its text's fonts. Read them before measuring pixels. Elements
  are named as `style.json` writes them, not by CSS selectors.

## Rights

Copying a reference is the person's call. These are facts from the sources, not legal advice.

- **Record the reference** with `asset-provenance` as supplied by the person, with where it came
  from, when it arrives:
  `node tools/provenance.ts record references/hero.mp4 --source "supplied by the person" --licence "the person's" --author "the person" --credit ""`
  (`--credit ""` keeps it in `ASSETS.md` and out of the video's credits). For a captured page,
  record its `tracks.json` or `style.json` with the page's URL as `--source`. `check` looks at
  the pictures, clips and sounds under `assets/`, or under the folders given with `--dir`.
- **Pinterest** forbids scraping: its Terms say "you agree not to scrape, collect, search, copy
  or otherwise access data or content from Pinterest" in ways it has not authorised, and its
  developer guidelines forbid "any automated means or form of scraping". The person saves the
  image. A Pin's poster belongs to whoever made it, often not the pinner.
- **In the US,** a typeface and a general layout are not registrable: "typeface, typefont,
  lettering, calligraphy, and typographic ornamentation are not registrable", and the general
  layout or format of a page, a website or a poster is not copyrightable (US Copyright Office,
  Compendium, §906.4 and §906.5). The artwork (photographs, illustrations) and the copy are
  protected on their own, and a font file is software. Other countries differ.
- **A site's web font is licensed to that site.** Its licence may not cover video: one foundry's
  web licence "does not grant you the right to use the Fonts for broadcast media". The capture
  names the fonts and never copies their files; the film needs a font file under a licence of the
  person's own.
- A page's images, code, shaders and models are not copied by the capture, only their hashes.
