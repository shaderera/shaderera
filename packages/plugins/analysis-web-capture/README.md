Capture a web page's motion once, as reference tracks a film reads and copies one to one: each
tracked element's box, transform and opacity at every frame, measured in your own Chrome on a
clock the capture holds, from the load or from a click, hover, leave or scroll sent at a time you
give. Or capture its look at one moment, as the style facts Chrome drew it with: every element's
box and computed styles, every text node's line boxes and fonts, and a screenshot.

```sh
node tools/capture-web.ts https://example.com/ --out references/hero \
  --track '.hero h1' --track '.hero .card' --fps 30 --rafHz 60 --duration 3 --viewport 1280x720
# writes references/hero/tracks.json

# the menu as it opens on a click at 500 ms
node tools/capture-web.ts https://example.com/ --out references/menu \
  --track '.menu' --fps 60 --rafHz 60 --duration 2 --viewport 1280x720 \
  --trigger click --target '.menu-button' --at 500

# the hero's look at 1.5 s
node tools/capture-web.ts https://example.com/ --out references/hero-look \
  --still 1500 --rafHz 60 --viewport 1280x720 --root '.hero'
# writes references/hero-look/style.json and style.png
```

```ts
import { at, loadTracks, track } from './reference/tracks.ts'

// in open
const hero = await loadTracks(host, 'references/hero/tracks.json')
const x = track(hero, '.hero .card', 'translateX')     // css-px, at source time

// in render(t)
const value = at(x, t, { between: 'linear' })
```

```ts
import { loadStyle, styleOf, textsOf } from './reference/style.ts'

// in open
const look = await loadStyle(host, 'references/hero-look/style.json')
const card = styleOf(look, '[data-id="card"]')
card.box                               // [x, y, width, height], css-px
card.styles['box-shadow']              // 'rgba(0, 0, 0, 0.25) 0px 12px 32px 0px'
textsOf(look, '[data-id="card"] > h1:nth-child(1)')[0]?.fonts
// [{ familyName, postScriptName, isCustomFont, glyphCount }]
```

`styleOf` and `textsOf` take an element's name as `style.json` writes it in `element` (below), not
a CSS selector: `.hero > h1` matches nothing.

The file is a `shaderera.analysis/1` artifact of kind `reference-tracks`, written by
`analysis-reference-tracks`' writer and read by its reader (see `docs/analysis.md` in the
`shaderera` package). The capture measures and decides nothing: no easing is fitted, no curve
smoothed, no time stretched.

**The call.**
- `<url|file>`: an http, https or file URL, or a path to an HTML file.
- `--out <dir>`: the folder `tracks.json` goes in.
- `--track <selector>`: one CSS selector per element, repeated for more. The first match in
  document order is tracked; a selector list (`a, b`) is one selector.
- `--fps`, `--rafHz`, `--duration` (seconds from the load), `--viewport <width>x<height>` (CSS
  pixels): no defaults, since each changes every sample. Frames are at 0, 1/fps, … up to the
  duration.
- `--rafHz <n>`: how often the page's `requestAnimationFrame` runs, a whole multiple of the fps:
  otherwise a JS animation shows its last tick before the frame while CSS shows the frame itself
  (8.7 ms off at 24 fps with 60). Every multiple repeats, but a page that steps its motion once
  per animation frame (a spring, a lerp, a smooth scroll) moves differently at each, so give the
  refresh rate the reference was seen at.
- `--seed <n>` (1; 0 is a seed like any other), `--dpr <n>` (1), `--media <name>=<value>`
  (repeat; by default `prefers-color-scheme=light` and `prefers-reduced-motion=no-preference`),
  `--locale <BCP 47 tag>` (`en-US`: what `Intl`, `navigator.language` and `Accept-Language` see).
- `--allow-local`: let the page reach this machine and its network (loopback, private, link-local
  addresses). A page on `localhost` needs it. Cloud metadata addresses stay refused.
- `--cpu-throttle <n>`: run Chrome n times slower. The tracks must not change; if they do, the
  page reads a clock the capture does not hold.
- `--time-origin <ms>` (0), `--clock-date <ISO 8601>` (`2000-01-01T00:00:00.000Z`),
  `--timezone <IANA name>` (`UTC`): what the page's clocks read when the capture freezes them.
  `performance.now`, animation frame timestamps, `Event.timeStamp` and `document.timeline` start
  at the time origin, `Date` at the clock date, in that time zone. They are constants, never the
  real time of the capture, so a page that shows the date or animates from absolute time gives
  the same samples on every run; give the date and zone the reference showed when that matters.
- `--settle load|loaded`: when the clock freezes. `load` (the default) freezes it at the first
  script, so the page loads with its timers held. `loaded` lets the page run on real time until
  its load event and freezes it there, for a page that waits on its own timers while it loads
  (as [Playwright's clock guide](https://playwright.dev/docs/clock) does: let the page load, then
  pause). Frame 0 is the freeze in both. With `loaded`, what ran before the freeze ran at the
  machine's speed, so two captures can differ: the clocks read the time origin and the clock
  date plus the time the load took, which `source.loadedAt` records in seconds.
- `--trigger <what>`: what starts the motion. Each input is sent over the DevTools protocol's
  `Input` domain at its own time on the page's clock, as a person's would arrive, and the clock
  syncs once the browser has delivered it, so an animation the input starts starts at that time.
  The pointer goes to the centre of `--target`'s box (the first match), which must have a box
  (not `display: none`) in the viewport then; if another element covers that point, it gets the
  input and a limit says so. A capture holds one document: an input (or the page itself) that
  navigates to another, a link clicked say, is refused, since the new page has its own clock.
  `--at <ms>` is the page's time after frame 0, up to the last frame's (an input, or a scroll's
  end, after it would show on no frame, so it is refused). There are no defaults for these: each
  moves the motion.

  | `--trigger` | Takes | Sends |
  |---|---|---|
  | `load` (the default) | | nothing: the motion starts with the page |
  | `none` | | nothing: for motion that nothing starts (a loop, a drift); only the record differs from `load` |
  | `click` | `--target`, `--at` | the pointer jumps to the target's centre (one mousemove, no path), presses and releases the left button, all at `--at` |
  | `hover` | `--target`, `--at` | the pointer jumps to the target's centre at `--at` (one mousemove, no path) |
  | `leave` | `--target`, `--at` (above 0) | the pointer is on the target's centre from 0 ms, and moves to (-1, -1), just past the viewport's top-left corner, at `--at`, so it goes over nothing else |
  | `scroll` | `--at`, `--scroll-to <px>`, `--scroll-ms <ms>`, `--target` if the wheel should be over it (else the viewport's centre) | the pointer jumps to the wheel's point at `--at` (one mousemove), so it hovers what it turns over, as a person's does; wheel events from `--at` for `--scroll-ms`, evenly spaced and at most 1/rafHz second apart (one at `--at` for 0), in whole pixels on a straight line in time, adding up to `--scroll-to` minus the window's `scrollY` at `--at` |

  A scroll that does not end at `--scroll-to` (the page is shorter, an element under the pointer
  scrolled instead, the page took the wheel itself) is what the page did: a limit says where the
  window ended.

Each default above is a constant, never your OS's setting, so that two runs on two machines
repeat, and each is recorded (`params.seed`, `params.media`, `params.locale`, the clock's in
`params`, the pixel ratio in `frame.pixelRatio`). They still decide which variant of a page is
captured: the media defaults pick the light, full-motion variant of a page that has others,
`--dpr 1` its 1x images, `en-US` its English copy and number formats. Two more are fixed and
recorded: the page is always a desktop page (`params.mobile: false`: its viewport meta is
ignored and there is no touch, so a phone layout that depends on them is not captured), and
scrollbars are hidden (`--hide-scrollbars` in `tool.chromeFlags`), so an overflowing page is
laid out at the full viewport width, as with overlay scrollbars; a reference seen with classic
scrollbars was laid out about 15 CSS pixels narrower. Pass the values the reference was seen
with.

**A still.** `--still <ms>` reads the page at one time on its clock instead of its motion, and
writes `style.json`, a `shaderera.analysis/1` artifact of kind `reference-style`
(`src/reference/style.ts` reads it; `docs/analysis.md` defines it), and `style.png` beside it.
The page loads, the clock runs and a `--trigger` is sent as for motion, up to the still; then,
once the fonts it started loading have loaded, everything is read at once.
- `--still <ms>`: the time after the freeze. `--rafHz` has no default here and the still must be
  on one of its frames (500 at 60 is, 510 is not), so a JS animation is where CSS is. `--viewport`
  as for motion; `--track`, `--fps` and `--duration` are refused. A page with a dark scheme is
  captured in its light look unless `--media prefers-color-scheme=dark` is given: the default is
  there so your OS settings do not leak in, and it is recorded in `params.media`.
- `--root <selector>` (`:root`): the element whose subtree is read, the first match.
- `--style <property>`: a computed style read beside the default list, repeated for more. The
  default list is what changes how text, a box and its edges, its background, an image or an SVG
  shape are drawn (where it is and how big are its box):
  - text: `font-family`, `font-weight`, `font-style`, `font-stretch`, `font-size`,
    `line-height`, `letter-spacing`, `word-spacing`, `font-feature-settings`,
    `font-variation-settings`, `text-transform`, `text-align`, `text-decoration-line`, `-style`,
    `-color` and `-thickness`, `text-underline-offset`, `color`, `text-shadow`;
  - the box: `background-color`, `-image`, `-position`, `-size`, `-repeat` and `-clip`, each
    side's `border-*-width`, `-style` and `-color`, the four corner radii, `outline-width`,
    `-style`, `-color` and `-offset`, `box-shadow`;
  - drawing: `transform`, `translate`, `rotate`, `scale`, `transform-origin`, `opacity`,
    `visibility`, `filter`, `backdrop-filter`, `mix-blend-mode`, `clip-path`, `mask-image`,
    `object-fit`, `object-position`, and SVG's `fill`, `stroke` and `stroke-width`.

  Anything else (`white-space`, `cursor`, a grid's tracks) is one `--style` away. A custom
  property (`--accent`) cannot be read: the standard properties it feeds are.

What it reads, all from Chrome over the DevTools protocol, never from the pixels:
- each element and pseudo-element under the root, from `DOMSnapshot.captureSnapshot`: its box as
  drawn (after transforms, from the viewport's top left), its paint order and each style as
  computed. It is named by `[data-id="…"]` or `#id` when that is unique, else by its path from the
  document, or from the nearest ancestor with a unique data-id or id
  (`html > body:nth-child(2) > canvas:nth-child(3)`, `[data-id="card"] > h1:nth-child(1)`); an element in a shadow tree after its
  host and ` >>> `.
- each text node's line boxes, from the same snapshot, with the range of its text each holds.
  White space laid out between elements has no line box and no entry: nothing of it is drawn.
- the fonts each text node was drawn with, from `CSS.getPlatformFontsForNode`: family, PostScript
  name, whether it is a web font, and how many glyphs it drew. A fallback shows as a font of its
  own: a Thai line in a Latin web font lists the web font for its spaces and Latin letters, and
  the system font that drew the Thai.
- each web font the page loaded, as `CSS.fontsUpdated` reports it: family, `src`, weight, style,
  range, and the `platformFontFamily` it turned out to be, sorted, since they load in any order.
  The font files are never copied; a font inline in the page as a `data:` URL is kept as its media
  type only, and one from a `blob:` URL as its origin only (the rest is new on each load). Each
  file's sha256 is in `source.responses`, like every response.
- the screenshot, from `Page.captureScreenshot`, at the viewport in device pixels, with its
  sha256. `loadStyle` refuses a PNG that is not that one.

`DOMSnapshot` and `CSS` are experimental protocol domains, so `tool` records the Chrome version
and user agent, and a field Chrome no longer sends stops the capture with its name. A canvas,
video, iframe, embed or object is a limit: what it shows is in the screenshot only. So is an
input, textarea or select: the browser's own control draws its text, which the snapshot does not
hold. Two stills give the same bytes, JSON and PNG, but for `source.date`.

`loadStyle` and the kind's writer live in this plugin for now, as it is the one source of still
facts. When a second one comes (an image read by OCR, say), they move to a shared component, as
the tracks' reader did. The kind holds what a live page gives (paint order, the platform fonts,
the scroll): a source that cannot give a field changes the kind under a new format number.

One capture runs at a time on a machine (a lock in the OS temp folder).

**Chrome.** Your own: `CHROME` (as `docs/determinism.md` in the `shaderera` package documents
it), else the first of a few usual install paths. It starts in `--headless=new` with a throwaway profile in the OS temp folder, deleted afterwards
(also on Ctrl-C), never the project's `.shaderera/chrome`: no sign-ins, no cookies, nothing the
page writes is kept. Smooth scrolling is off, scrollbars are hidden, service workers are
bypassed.

**The clock** (`tools/inpage/clock.js`, ported from reanimate's, MIT) is injected before any page
script and freezes the page from its first script (with `--settle loaded`, at the load event):
`Date`, `performance.now`, timers, `requestAnimationFrame`, `requestIdleCallback`,
`Event.timeStamp`, `document.timeline`, every CSS and Web Animations API animation, `<video>`,
and a seeded `Math.random`. An animation is caught on
the time it started, whether a timer, an animation frame, a promise or a MessageChannel task
(React's scheduler) or an input started it. Each frame, in this order: an input due by the
frame's time is sent at its own time (the clock advanced to it, then synced once the browser has
delivered it and any scroll has landed), animations are synced, the clock advances to the frame's
time (timers and animation frames run in time order, a tick due at the frame included), the
capture waits for the network and the page's pending worker replies and video seeks, then every
element is read. An input at a frame's time is sent before that frame is read, so the frame shows
the page right after it and the motion shows on the next. So frame k is the page at k / fps
however slow the machine is: two captures give the same bytes but for `source.date` (and, with
`--settle loaded`, what the load did on real time).

**What each element gets**, one track per channel:

| Channel | Unit | Read from |
|---|---|---|
| `x`, `y`, `width`, `height` | `css-px` | `getBoundingClientRect()`: the box as drawn, after transforms, from the viewport's top left |
| `opacity` | `ratio` | its computed `opacity` (its own, not its ancestors') |
| `translateX`, `translateY` | `css-px` | the transform matrix: the `translate`, `rotate` and `scale` properties, then `transform`, composed as CSS composes them |
| `rotate`, `skewX` | `deg` | the same matrix, as `translate() rotate() skewX() scale()`, which builds it back |
| `scaleX`, `scaleY` | `ratio` | the same; `scaleX` is never negative, so a mirror shows as a negative `scaleY` and a half turn |
| `originX`, `originY` | `css-px` | its computed `transform-origin`, from its border box's top left |

`rotate` is unwrapped: each sample is the angle nearest the one before, so a turn past 180°
keeps counting. A value is `null` on a frame where nothing matches the selector.

The window itself is the element `window`, with `scrollX` and `scrollY` (`css-px`, from
`window.scrollX` and `scrollY`) on every capture, whatever the trigger: scroll-linked motion is
read against `scrollY` as well as time. No `--track` may be named `window`.

**`declared`** holds every animation the page ran (from the clock, which sees each one as it
starts, and `document.getAnimations()`), each once, in the order first seen, as the page wrote
it and Chrome returns it, never fitted:
- `element`: the `--track` selector when the animation's target is that selector's tracked
  element; else the target's `#id` when it is unique, else its path from the root
  (`html > body:nth-child(2) > div:nth-child(3)`); the tag with `"inDocument": false` for a target
  out of the document or in a shadow root. `pseudoElement` (`::after`) when it is on one.
- `type` (`css-transition`, `css-animation`, `web-animation`), the transition's `property` or the
  animation's `name`, its `id`, `playbackRate` and `composite`.
- `start`: the source second the clock first saw it running (`docs/analysis.md` defines it for
  every page analyser); negative for one that began before a `--settle loaded` freeze, absent for
  one the clock does not hold.
- `timing`: every field of `getTiming()` (delay, direction, duration, easing, endDelay, fill,
  iterationStart, iterations), unchanged, but for infinite iterations, which JSON cannot hold:
  `"infinite"`, as CSS writes it. A CSS animation's own timing function is in its keyframes'
  `easing`, as Chrome reports it, and its `timing.easing` is `linear`.
- `keyframes`: `getKeyframes()` as returned: each keyframe's `offset`, `computedOffset`, `easing`,
  `composite` and property values as strings.
- `timeline`, for one not on the document timeline: `{ "type": "scroll", "source": "window",
  "axis": "block" }`, `{ "type": "view", "subject", "axis" }`, or `{ "type": "none" }`.

Read them when the motion is CSS or WAAPI: they are the page's own numbers, exact at any time.

**`source`** is the URL, the date, the viewport, the pixel ratio and each response's status and
sha256. The hash is of the body's bytes as served, after any `Content-Encoding` is undone: a
response with a `Content-Length` (up to 16 MB) is held at its headers until its bytes are read,
and a file is read from disk. A response without a length may be a stream, which holding would
stop, so it is read once it has loaded: Chrome keeps a binary body as bytes, but a text body only
as the text it decoded with its charset, so such a response carries `"hashOf": "text-as-utf8"`
(that text encoded as UTF-8, the served file only when it was UTF-8). A body Chrome did not keep
(an image it could not decode) has no hash and is a limit. **`tool`** is this script's version, the
Chrome version and user agent, its flags, and the clock's version and sha256. **`params`** are the
fps, `rafHz`, the seed, `timeOrigin`, `clockDate`, `timezone`, `locale`, the duration, the
selectors, the media features, `allowLocal`, `mobile` (always `false`), `settle` and `trigger`: its
`type` and the settings it took (`target`, `at`, `scrollTo`, `scrollMs`), and the `pointer`
`{ x, y }` in CSS pixels where its input went, so a film can put a cursor where the page saw one.
For a `leave` it is where the pointer was from 0 ms until `at`; then it is at `leftTo`
(`{ x: -1, y: -1 }`), off the viewport. A scroll without `--target` also records `over`, the
element the wheel's point was over (`div#hero`, `nothing`), so a hover state it shows can be read
back to it. With `trigger` `load` frame 0 is the page once it has loaded. A capture sends one
trigger; a later version that sends several would list them in a new field and keep `trigger` as
the first.

**Outside requests.** Chrome's only way out is a proxy in the tool, loopback included. It resolves
each host once, refuses it when any of its addresses is loopback, private, link-local, cloud
metadata (169.254.169.254, `metadata.google.internal`…) or otherwise not public, and connects to
the addresses it checked, so a name cannot pass the check and then reach 127.0.0.1. A refused
request fails in the page and is listed in `limits`. WebRTC sends nothing outside the proxy.
A page given as a file reads files, as Chrome lets it.

**Limits recorded in `limits`** when the capture meets them:
- Iframes and workers run on real time; the clock holds the top frame only. A worker's reply is
  waited for (2 s at most), its own clock is not held.
- A 3D transform: `rotate`, `skewX`, `scaleX` and `scaleY` are of its 2D part; the box is as drawn.
  An `offset-path`, or a `translate` the capture cannot read (`calc()`, or a percentage on an SVG
  element, whose box depends on `transform-box`), is left out of the transform channels. A
  percentage on an HTML element is of its border box, unrounded.
- More than one element matching a selector: the first is tracked.
- A request open for more than 5 s stops holding frames back, and a frame that does not settle in
  15 s is read as it is.
- Input goes to the top frame at the target's centre; an iframe under it gets it on its own
  clock. There is no pointer path, touch, keyboard or drag yet: a page that reacts to mousemove
  (a magnetic button, a tilt) gets one move from nowhere. A click's press and release are one
  instant, so an `:active` look shows on no frame.
- A request the proxy refused, a response that did not load, or one whose body has no hash.

**Limits not held and not detected**: a capture that meets them has nothing in `limits` for them.
- Scroll and view timelines are not on the clock: they follow the scroll position, which input or
  the page's own script moves (both on the capture's clock), and which the `window` channels
  record.
- Canvas and WebGL drawing (no channel reads them), `AudioContext`, `requestVideoFrameCallback`,
  `Temporal`, `crypto.getRandomValues`, GIF and APNG frames.
- A response that arrives while a frame's timers run can land on that frame or the next.
- Fonts installed on the machine: text whose web font is missing, or lacks a glyph, falls back to
  them, and they are neither held nor recorded (only web fonts' response hashes are; a still
  names the fonts it drew with, not their files).
- The layout box before transforms is not a channel: `x`, `y`, `width`, `height` are the box as
  drawn.

Run it twice (once with `--cpu-throttle 6`) before you build on a capture: the files must differ
only in `source.date` (with `--settle loaded`, also in `source.loadedAt` and what the load did on
real time). Copying a site's motion is your call, as for any outside media: record the
URL with `asset-provenance`. Fonts, images and code the page loads are not copied; only their
hashes are kept. A still names the fonts it drew with; copying a font needs its own licence.
