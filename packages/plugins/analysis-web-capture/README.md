Capture a web page's motion once, as reference tracks a film reads and copies one to one: each tracked element's box, transform and opacity at every frame, measured in your own Chrome on a clock the capture holds.

```sh
node tools/capture-web.ts https://example.com/ --out references/hero \
  --track '.hero h1' --track '.hero .card' --fps 30 --rafHz 60 --duration 3 --viewport 1280x720
# writes references/hero/tracks.json
```

```ts
import { at, loadTracks, track } from './reference/tracks.ts'

// in open
const hero = await loadTracks(host, 'references/hero/tracks.json')
const x = track(hero, '.hero .card', 'translateX')     // css-px, at source time

// in render(t)
const value = at(x, t, { between: 'linear' })
```

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

One capture runs at a time on a machine (a lock in the OS temp folder).

**Chrome.** Your own: `CHROME` (as `docs/determinism.md` in the `shaderera` package documents
it), else the first of a few usual install paths. It starts in `--headless=new` with a throwaway profile in the OS temp folder, deleted afterwards
(also on Ctrl-C), never the project's `.shaderera/chrome`: no sign-ins, no cookies, nothing the
page writes is kept. Smooth scrolling is off, scrollbars are hidden, service workers are
bypassed.

**The clock** (`tools/inpage/clock.js`, ported from reanimate's, MIT) is injected before any page
script and freezes the page from the start: `Date`, `performance.now`, timers,
`requestAnimationFrame`, `requestIdleCallback`, `Event.timeStamp`, `document.timeline`, every CSS
and Web Animations API animation, `<video>`, and a seeded `Math.random`. An animation is caught on
the time it started, whether a timer, an animation frame, a promise or a MessageChannel task
(React's scheduler) started it. The motion starts at the load and no input is sent; a trigger
added later (a click, a scroll) must sync the clock after each input, as timers and frames do.
Each frame, in this order:
animations are synced, the clock advances to the frame's time (timers and animation frames run in
time order, a tick due at the frame included), the capture waits for the network and the page's
pending worker replies and video seeks, then every element is read. So frame k is the page at
k / fps however slow the machine is: two captures give the same bytes but for `source.date`.

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

**`declared`** holds each animation the page ran on a tracked element, as Chrome reports it:
type (`css-transition`, `css-animation`, `web-animation`), the transition's property or the
animation's name, `start` (the source second the clock first saw it running; `docs/analysis.md`
defines it for every page analyser), `timing` (duration, delay,
easing, iterations, fill…) and `keyframes`. Read them when the motion is CSS or WAAPI: they are
the page's own numbers, exact at any time.

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
selectors, the media features, `allowLocal`, `mobile` (always `false`) and `trigger: "load"` (frame 0 is the page once it has loaded).

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
- A request the proxy refused, a response that did not load, or one whose body has no hash.

**Limits not held and not detected**: a capture that meets them has nothing in `limits` for them.
- Scroll and view timelines, canvas and WebGL drawing (no channel reads them), `AudioContext`,
  `requestVideoFrameCallback`, `Temporal`, `crypto.getRandomValues`, GIF and APNG frames.
- A response that arrives while a frame's timers run can land on that frame or the next.
- Fonts installed on the machine: text whose web font is missing, or lacks a glyph, falls back to
  them, and they are neither held nor recorded (only web fonts' response hashes are).
- The layout box before transforms is not a channel: `x`, `y`, `width`, `height` are the box as
  drawn.

Run it twice (once with `--cpu-throttle 6`) before you build on a capture: the files must differ
only in `source.date`. Copying a site's motion is your call, as for any outside media: record the
URL with `asset-provenance`. Fonts, images and code the page loads are not copied; only their
hashes are kept.
