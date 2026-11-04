# Reference motion capture

Research of 2026-11-04, before a feature that copies motion 1:1 from a reference, notably a live
outside web page, as [reanimate](https://github.com/NiazMorshed2007/reanimate) (MIT) does. It
asked two things: can CDP's virtual time capture GSAP and spring animations frame by frame, or
must the page's clock be replaced from inside; and does capturing an outside page belong in core
or in a plugin. reanimate was read at
[3f7a55a](https://github.com/NiazMorshed2007/reanimate/tree/3f7a55a2986a84ca2173e86ee9127eefe31d046d),
Shaderera at 8337d8f.

## Conclusion

**Clock: inject one, do not rely on CDP.** Port reanimate's `clock.js` (MIT, about 260 lines),
injected before any page script. It already pauses and seeks CSS and Web Animations the way
`dom.ts` holds them. CDP virtual time is not an option for Shaderera:
- it is experimental. Chrome 156 in `--headless=new` accepts it and stops time, but in
  [the experiments](#experiments-2026-11-04) rAF ran every 16.6 ms in one run and 33.4 ms in
  the next, CSS and JS stalled for frames, and a 6× throttled run hung;
- the frame control that makes it frame-exact (`HeadlessExperimental.beginFrame`) works only in
  `chrome-headless-shell`, and not on macOS at all.
The experiments also show that `clock.js` as published is not deterministic: it needs three
small fixes, after which every capture was byte-identical.
Every library asked about reads a clock that an in-page shim can replace: GSAP reads `Date.now`,
motion and react-spring read `performance.now`, and all three are driven by
`requestAnimationFrame`. Every capture tool that works on today's Chrome (timesnap, Playwright's
`page.clock`, puppeteer-capture, WebVideoCreator) shims time in the page, and the last two add
`beginFrame` only for pictures. Per-element tracks need no pictures: computed style and layout
read after each step already hold that frame's state.

**Place: a component plugin, with nothing new in core.** Capture is an analyser:
- it turns a reference into `shaderera.analysis/1` data;
- it runs once, apart from rendering, as a script the person runs;
- it is optional, like `review-shots`, `audio-listen` and `image-regions`.
0011's test lets capture into core, since it decides no look, but it does not put it there.
analysis.md and the existing plugins do: core owns time, identity and replay, never the
analysers. The plugin starts its own Chrome in a throwaway profile, never the project's
`.shaderera/chrome`. It finds Chrome as the CLI does (`CHROME`, else the install paths).
Exporting the CLI's `chromePath` is the only thing worth adding to core, and it is optional.

## Q1: what each time source is

### CDP virtual time

- `setVirtualTimePolicy` and its policies (`advance`, `pause`, `pauseIfNetworkFetchesPending`)
  are marked experimental
  ([Emulation.pdl#L70-L78](https://github.com/ChromeDevTools/devtools-protocol/blob/b0d96c6cdf39e5583e67a3762b2815a33154455b/pdl/domains/Emulation.pdl#L70-L78)).
  - `budget` pauses time after that many virtual ms and fires `virtualTimeBudgetExpired`.
  - `maxVirtualTimeTaskStarvationCount` forces time forward to avoid deadlock.
  - `initialVirtualTime` overrides `Date.now`'s base.
  - It returns `virtualTimeTicksBase`.
  - Sources: [#L510-L526](https://github.com/ChromeDevTools/devtools-protocol/blob/b0d96c6cdf39e5583e67a3762b2815a33154455b/pdl/domains/Emulation.pdl#L510-L526), [#L552-L553](https://github.com/ChromeDevTools/devtools-protocol/blob/b0d96c6cdf39e5583e67a3762b2815a33154455b/pdl/domains/Emulation.pdl#L552-L553).
- **What it overrides.** Blink overrides `base::Time::Now` and `TimeTicks::Now` for the whole
  renderer process
  ([process_time_override_coordinator.cc#L82-L84](https://github.com/chromium/chromium/blob/5825b25f9c4edd1537c952e6a02cfa2edb5bbe47/third_party/blink/renderer/platform/scheduler/common/process_time_override_coordinator.cc#L82-L84)).
  Delayed tasks then run back to back, and `pause` holds them
  ([virtual_time_controller.h#L15-L52](https://github.com/chromium/chromium/blob/5825b25f9c4edd1537c952e6a02cfa2edb5bbe47/third_party/blink/renderer/platform/scheduler/public/virtual_time_controller.h#L15-L52)).
  `advance` jumps to the next timer; it does not step in frames.
- **How Chromium itself captures frames.** Its own test helper pairs the policy with
  `HeadlessExperimental.beginFrame({frameTimeTicks})` at every frame
  ([virtual-time-controller.js#L47-L57, #L127-L148](https://github.com/chromium/chromium/blob/5825b25f9c4edd1537c952e6a02cfa2edb5bbe47/headless/test/data/protocol/helpers/virtual-time-controller.js#L47-L57)).
  The rAF and animation time come from that BeginFrame.
- **`beginFrame` is headless-shell only.**
  - It needs a target created with BeginFrameControl and `--run-all-compositor-stages-before-draw`
    ([HeadlessExperimental.pdl#L7-L56](https://github.com/ChromeDevTools/devtools-protocol/blob/b0d96c6cdf39e5583e67a3762b2815a33154455b/pdl/domains/HeadlessExperimental.pdl#L7-L56),
    [headless_handler.cc#L142-L153](https://github.com/chromium/chromium/blob/5825b25f9c4edd1537c952e6a02cfa2edb5bbe47/headless/lib/browser/protocol/headless_handler.cc#L142-L153)).
  - `--deterministic-mode` bundles those flags, and is incompatible with `--site-per-process`
    ([command_line_handler.cc#L38-L54](https://github.com/chromium/chromium/blob/5825b25f9c4edd1537c952e6a02cfa2edb5bbe47/headless/lib/browser/command_line_handler.cc#L38-L54)).
  - The handler exists only under `headless/lib/`, the shell
    ([headless_handler.cc](https://github.com/chromium/chromium/blob/5825b25f9c4edd1537c952e6a02cfa2edb5bbe47/headless/lib/browser/protocol/headless_handler.cc)).
  - On macOS, creating such a target fails: "BeginFrameControl is not supported on MacOS yet"
    ([target_handler.cc#L62-L67](https://github.com/chromium/chromium/blob/5825b25f9c4edd1537c952e6a02cfa2edb5bbe47/headless/lib/browser/target_handler.cc#L62-L67)).
- **New headless supports neither.** A Chromium maintainer wrote: "Virtual time and manual frame
  control are not supported in the new headless"; they stay in `headless_shell`, which is leaving
  Chrome ([headless-dev, 2024-11-19](https://groups.google.com/a/chromium.org/g/headless-dev/c/WgNE0CAlx-8)).
  Since 132.0.6793.0, old headless ships only as the separate `chrome-headless-shell` binary
  ([Chrome Headless mode](https://developer.chrome.com/docs/chromium/headless)).
- **Shaderera's Chrome is new headless, not the shell.** It runs the user's own Google Chrome
  with `--headless=new` ([browser.ts#L36-L45](../../apps/cli/src/node/browser.ts#L36-L45)), as
  0006 decided ([0006](../adr/0006-browser-host-and-dom.md)). So CDP time would need a second
  binary, would never work on macOS, and rests on experimental, unsupported code.

### The libraries

- **GSAP 3.15.1**
  - Clock: the ticker reads `_getTime = Date.now`. Defaults: `lagThreshold` 500 ms,
    `adjustedLag` 33 ms
    ([gsap-core.js#L887-L889](https://github.com/greensock/GSAP/blob/5e6c35ff8eedea12d4f229129def635277d8b0f2/src/gsap-core.js#L887-L889)).
  - Lag: `_tick` measures `Date.now() - _lastUpdate`. Over the threshold, it counts only 33 ms.
    It ignores the rAF timestamp
    ([#L896-L919](https://github.com/greensock/GSAP/blob/5e6c35ff8eedea12d4f229129def635277d8b0f2/src/gsap-core.js#L896-L919)).
  - Scheduler: rAF, falling back to `setTimeout`
    ([#L937-L939](https://github.com/greensock/GSAP/blob/5e6c35ff8eedea12d4f229129def635277d8b0f2/src/gsap-core.js#L937-L939)).
  - `lagSmoothing(0)` sets the threshold to Infinity
    ([#L949-L952](https://github.com/greensock/GSAP/blob/5e6c35ff8eedea12d4f229129def635277d8b0f2/src/gsap-core.js#L949-L952);
    [gsap.ticker](https://gsap.com/docs/v3/GSAP/gsap.ticker/)).
  - On a real clock, a slow frame therefore loses time. A virtual clock that steps 16.7 ms never
    reaches the threshold, so an outside page needs no `lagSmoothing(0)`. Nor can the capture
    call it: the page's `gsap` is usually not a global.
- **motion 14.9.1 (Framer Motion)**
  - Clock: the frameloop reads `performance.now()`, not the rAF timestamp. It clamps each delta
    to between 1 and 40 ms (`maxElapsed`)
    ([batcher.ts#L6, #L38-L49](https://github.com/motiondivision/motion/blob/6be4a29207eae179b315293111233cab660426b1/packages/motion-dom/src/frameloop/batcher.ts#L38-L49)).
  - Scheduler: rAF
    ([frame.ts#L9-L13](https://github.com/motiondivision/motion/blob/6be4a29207eae179b315293111233cab660426b1/packages/motion-dom/src/frameloop/frame.ts#L9-L13)).
  - `MotionGlobalConfig` has `useManualTiming`, `instantAnimations` and `skipAnimations`
    ([global-config.ts#L1-L7](https://github.com/motiondivision/motion/blob/6be4a29207eae179b315293111233cab660426b1/packages/motion-utils/src/global-config.ts#L1-L7)).
  - Opacity and transform can run as WAAPI on the browser's clock. Manual timing moves them to JS
    ([process-frame.ts#L6-L39](https://github.com/motiondivision/motion/blob/6be4a29207eae179b315293111233cab660426b1/packages/motion-dom/src/frameloop/process-frame.ts#L6-L39),
    [waapi.ts#L23-L30](https://github.com/motiondivision/motion/blob/6be4a29207eae179b315293111233cab660426b1/packages/motion-dom/src/animation/waapi/supports/waapi.ts#L23-L30)).
  - On an outside page those flags are bundled and out of reach. So the clock must cover both
    `performance.now` and the WAAPI animations, which `clock.js` does.
- **react-spring 10.1.2**
  - Clock: `raf.now` is `performance.now()`. `frameLoop` defaults to `'always'`, and
    `raf.advance()` works only under `'demand'`
    ([rafz/index.ts#L95-L112](https://github.com/pmndrs/react-spring/blob/59b1e5306402d3039120e2da464b66e10b1a1aa1/packages/rafz/src/index.ts#L95-L112)).
  - Each step's dt is clamped to 64 ms
    ([#L158-L176](https://github.com/pmndrs/react-spring/blob/59b1e5306402d3039120e2da464b66e10b1a1aa1/packages/rafz/src/index.ts#L158-L176)).
  - `Globals.skipAnimation` jumps to the goal
    ([globals.ts#L68-L76](https://github.com/pmndrs/react-spring/blob/59b1e5306402d3039120e2da464b66e10b1a1aa1/packages/shared/src/globals.ts#L68-L76)).
  - With virtual 60 Hz frames, the clamp never fires.

Both spring libraries clamp a slow frame's delta. On a real clock, frame k is therefore not the
state at k/fps on a slow machine. On a virtual clock with a fixed rAF step it is.

### Prior art

- **timesnap** overrides `Date`, `performance.now`, rAF and timers in the page. It says CSS
  animations and transitions "will likely not render as intended"
  ([README#L9-L10, #L309](https://github.com/tungs/timesnap/blob/6782c67e8eefa2cb3ee87414662fb17883cf894f/README.md#L9-L10)).
- **Playwright's `page.clock`** fakes these, and has `runFor`, `pauseAt` and `fastForward`
  ([clock.md#L11-L37](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/docs/src/clock.md#L11-L37)):
  - `Date`, timers, rAF and idle callbacks;
  - `performance` and `Event.timeStamp`.

  Its injected clock rounds rAF to 16 ms boundaries
  ([clock.ts#L400](https://github.com/microsoft/playwright/blob/cfe490d941f992655948eee8fd4fd94e1c4234bf/packages/injected/src/clock.ts#L400)).
  It never touches `document.timeline` or `getAnimations`, so CSS and WAAPI animations keep real
  time (inferred from their absence).
- **puppeteer-capture** needs `chrome-headless-shell` and `--deterministic-mode`. It shims time
  in the page and calls `beginFrame` for each picture
  ([PuppeteerCaptureViaHeadlessExperimental.ts#L16-L26, #L149-L178, #L240-L249](https://github.com/alexey-pelykh/puppeteer-capture/blob/359dd717a8aeade0d0bcfc127b7e34b6d8c3e496/src/PuppeteerCaptureViaHeadlessExperimental.ts#L16-L26)).
  It lists new headless and macOS as unsupported
  ([KNOWN_ISSUES.md#L3-L19](https://github.com/alexey-pelykh/puppeteer-capture/blob/359dd717a8aeade0d0bcfc127b7e34b6d8c3e496/KNOWN_ISSUES.md#L3-L19)).
- **WebVideoCreator**
  - It shims timers, rAF, `Date` and `performance.now`
    ([CaptureContext.js#L375-L451](https://github.com/Vinlic/WebVideoCreator/blob/fb62279513ca0ac01f6b8864a1e43101cbc9532e/core/CaptureContext.js#L375-L451)).
  - It seeks CSS animations with CDP `Animation.seekAnimations`
    ([Page.js#L528-L550](https://github.com/Vinlic/WebVideoCreator/blob/fb62279513ca0ac01f6b8864a1e43101cbc9532e/core/Page.js#L528-L550)).
  - On macOS it needs a mode without `beginFrame`
    ([README.en-US.md#L329](https://github.com/Vinlic/WebVideoCreator/blob/fb62279513ca0ac01f6b8864a1e43101cbc9532e/README.en-US.md#L329)).
- **Remotion** drives everything from `useCurrentFrame()` and seeks a paused GSAP timeline. It
  does not use the libraries' own clocks
  ([third-party](https://www.remotion.dev/docs/third-party), [gsap](https://www.remotion.dev/docs/gsap)).
  That works for code you write, not for an outside page.

### reanimate's clock.js

What it covers:
- **Random:** seeded `Math.random` (mulberry32), in workers too
  ([clock.js#L14-L26](https://github.com/NiazMorshed2007/reanimate/blob/3f7a55a2986a84ca2173e86ee9127eefe31d046d/skills/reanimate/scripts/inpage/clock.js#L14-L26)).
- **Timers:** `setTimeout` and `setInterval`, with the browser's 4 ms clamp on nested timers, and
  `requestIdleCallback`
  ([#L54-L88](https://github.com/NiazMorshed2007/reanimate/blob/3f7a55a2986a84ca2173e86ee9127eefe31d046d/skills/reanimate/scripts/inpage/clock.js#L54-L88)).
- **rAF:** ticks every `1000/rafHz` ms with the virtual timestamp
  ([#L91-L111](https://github.com/NiazMorshed2007/reanimate/blob/3f7a55a2986a84ca2173e86ee9127eefe31d046d/skills/reanimate/scripts/inpage/clock.js#L91-L111)).
- **Animations:** every CSS transition and WAAPI animation on the document timeline is paused when
  first seen and then seeked. Finite ones are `finish()`ed, so the `finished` promises motion
  waits on still resolve ([#L113-L137](https://github.com/NiazMorshed2007/reanimate/blob/3f7a55a2986a84ca2173e86ee9127eefe31d046d/skills/reanimate/scripts/inpage/clock.js#L113-L137)).
- **Video:** `<video>` is paused and seeked ([#L138-L158](https://github.com/NiazMorshed2007/reanimate/blob/3f7a55a2986a84ca2173e86ee9127eefe31d046d/skills/reanimate/scripts/inpage/clock.js#L138-L158)).
- **Clocks:** `performance.now`, `Date`, `Event.timeStamp` and `document.timeline.currentTime`
  ([#L164-L181](https://github.com/NiazMorshed2007/reanimate/blob/3f7a55a2986a84ca2173e86ee9127eefe31d046d/skills/reanimate/scripts/inpage/clock.js#L164-L181)).
- **Scheduling:** `advance(ms)` runs timers and frames in time order. It yields a MessageChannel
  task between callbacks, so React's scheduler and promise chains keep up
  ([#L211-L248](https://github.com/NiazMorshed2007/reanimate/blob/3f7a55a2986a84ca2173e86ee9127eefe31d046d/skills/reanimate/scripts/inpage/clock.js#L211-L248)).

capture.ts injects it before any page script, through Playwright's `addInitScript`. It turns off
smooth scrolling, which runs on the compositor's real clock
([capture.ts#L338-L348](https://github.com/NiazMorshed2007/reanimate/blob/3f7a55a2986a84ca2173e86ee9127eefe31d046d/skills/reanimate/scripts/capture.ts#L338-L348)).

Gaps:
- **Workers keep real time.** A worker gets the seed only; capture waits up to 2 s for its
  replies ([#L183-L208](https://github.com/NiazMorshed2007/reanimate/blob/3f7a55a2986a84ca2173e86ee9127eefe31d046d/skills/reanimate/scripts/inpage/clock.js#L183-L208)).
- **Scroll and view timelines are skipped** ([#L121](https://github.com/NiazMorshed2007/reanimate/blob/3f7a55a2986a84ca2173e86ee9127eefe31d046d/skills/reanimate/scripts/inpage/clock.js#L121)). A scroll-driven
  reference needs scroll positions scripted at virtual times.
- **rAF steps at `rafHz` (60 by default).** At 24 or 30 fps, a JS animation shows its last tick
  before t, while CSS is seeked to exactly t. The capture rate should be a divisor of `rafHz`, or
  `rafHz` set to it.
- **Not covered:** GIF and APNG images, `AudioContext.currentTime`, `requestVideoFrameCallback`,
  `Temporal.Now` (Playwright fakes it) and `performance.timeOrigin`.
- **Not every animation is caught.** One the page keeps paused, or one that starts and ends
  between two frames, is not seeked.

The Shaderera side already holds animations at t:
[dom.ts#L71-L77](../../apps/cli/src/runner/dom.ts#L71-L77) runs `pause()` and then
`currentTime = t*1000`, which is the same mechanism.

### Recommendation

- **Injected clock, alone.** Port `clock.js` with its MIT notice. Inject it with
  `Page.addScriptToEvaluateOnNewDocument`
  ([Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-addScriptToEvaluateOnNewDocument))
  over the CLI's raw CDP; Playwright is not needed.
- **Keep its animation seek.** It does what `dom.ts` does, plus `finish()`.
- **Read the state, not pixels.** For each frame: `advance(1000/fps)`, wait for network quiet
  and `busy()`, then read each tracked element's rect and computed transform, opacity and colour.
  Reading forces style and layout, so no BeginFrame is needed.
- **Flags.** Launch with `--disable-smooth-scrolling`; set `rafHz` to the capture fps or a
  multiple of it.
- **CDP virtual time: none.** It is out of reach in new headless. Adding it later would only
  double-drive time.

Minimal experiments to confirm:
1. **Speed independence.** A GSAP page, a motion spring (one JS-driven `x`, one WAAPI `opacity`)
   and a react-spring page, captured at 1× and under `Emulation.setCPUThrottlingRate` 6×. The
   tracks must be equal.
2. **Repeats.** Capture the same page twice. The JSON must be byte-identical.
3. **Triggered motion.** A CSS transition and a motion `animate()` started by a click at virtual
   t = 500 ms. They must start on the same frame and finish when expected.
4. **fps against `rafHz`.** At 24 fps with `rafHz` 60, then with `rafHz` 24: measure the JS
   versus CSS phase error.
5. **A negative control.** In the CLI's Chrome (`--headless=new`, macOS and Windows), call
   `Emulation.setVirtualTimePolicy` with `pause`. Record whether it errors and whether
   `performance.now` and rAF stop. This confirms the mailing-list claim on our Chrome.
6. **A worker and a canvas page.** A worker-driven animation and a WebGL or Canvas2D one:
   document what drifts.

## Q2: plugin or core

What the decisions say:
- **0011's test is a filter, not a placement.** "If it decides how a frame looks, it is not core"
  ([0011 point 2](../adr/0011-experts-and-agents-no-taste-lock.md)). Capture passes it, and so
  could be core. The same ADR's plumbing items (music analysis, image decoding) are still plugins.
- **analysis.md places analysers outside core.**
  - Analysis runs apart from rendering, and "core installs no model".
  - "An analyser is a script the user runs … Each one is optional."
  - Core owns "time alignment, artifact identity, failure and replay"
  ([analysis.md#L12-L17](../analysis.md#L12-L17)).
  - "Analysis takes files only. A live source can be recorded by the user's own tools into the
    artifact format" ([#L70-L75](../analysis.md#L70-L75)). A live web page is such a source.
- **The existing analysers are all component plugins with `tools/` scripts.** Their only
  Shaderera import is `sha256` from `@shaderera/core`.
  - `review-shots` is Python ([shaderera.item.json](../../packages/plugins/review-shots/shaderera.item.json)).
  - `audio-listen` brings `@huggingface/transformers`
    ([shaderera.item.json](../../packages/plugins/audio-listen/shaderera.item.json),
    [listen.ts#L22](../../packages/plugins/audio-listen/tools/listen.ts#L22)).
  - `image-regions` is the same
    ([regions-from-masks.ts#L9](../../packages/plugins/image-regions/tools/regions-from-masks.ts#L9)).
  - The plugin guide says heavy work goes "in a `tools/` script run once"
    ([plugin-guide.md#L140-L144](../plugin-guide.md#L140-L144)).
- **0018 allows a plugin before a film, marked experimental**
  ([0018](../adr/0018-hearing-with-clap.md)). 0008 keeps core to "the boring production work"
  ([0008](../adr/0008-core-extensions-and-catalog.md)).
- **Neither 0016 nor 0021 fits capture.** A bake is frames a render reads
  ([0016](../adr/0016-bakes.md)); capture's output is data. The studio drives the CLI's own
  commands ([0021](../adr/0021-studio-drives-the-local-cli.md)) and can run a plugin's tool later.
- **0017 names a risk.** It keeps "fetching a site's pages through the person's browser" out
  ([0017](../adr/0017-outside-media.md)). Capturing in a fresh profile, with no sign-ins, stays
  clear of it.

What core has today:
- **Chrome lookup and launch are private to the CLI.**
  - `chromePath()` checks `CHROME`, then three install paths.
  - `startChrome` and the CDP `session` live in
    [browser.ts#L36-L60, #L99](../../apps/cli/src/node/browser.ts#L36-L60).
  - `doctor` reports the result ([doctor.ts#L214-L244](../../apps/cli/src/cli/doctor.ts#L214-L244)).
- **A plugin cannot import any of it.** The `shaderera` package exports only `./package.json`
  ([package.json#L17-L19](../../apps/cli/package.json#L17-L19)). `@shaderera/core` exports `.`,
  `./host` and `./gpu`, with no Chrome code
  ([package.json#L14-L18](../../packages/core/package.json#L14-L18)).
- **The project profile is the wrong place for an outside page.** It is `.shaderera/chrome`, kept
  for the pipeline cache and locked per host
  ([browser.ts#L259-L289](../../apps/cli/src/node/browser.ts#L259-L289)). The doctor probe
  already uses a throwaway `mkdtemp` profile
  ([browser.ts#L167-L176](../../apps/cli/src/node/browser.ts#L167-L176)), which is the pattern to
  copy.
  - An outside page must not write cookies, storage or service workers into a profile the
    project's runner reuses.
  - It must not share a process with the runner server on 127.0.0.1.

Recommendation:
- **A component plugin**, for example `analysis-web-motion`, under "Analysis & Tracking",
  plumbing, experimental. It holds:
  - `tools/capture.ts` with the ported clock;
  - a reader in `src/` for the tracks.

  Requires: `shaderera` range and `@shaderera/core` for `sha256`.
- **Its own Chrome.**
  - Found by `CHROME`, else the same install paths: a duplicated 10 lines.
  - `--headless=new`, with a fresh `mkdtemp` profile under the OS temp directory, deleted after.
  - `--disable-smooth-scrolling`, and no remote port beyond `0`.
  - A small CDP client of its own, or `puppeteer-core` / `playwright-core` pointed at that
    executable through `requires.packages`.
- **Its output** is a `shaderera.analysis/1` artifact with per-element tracks keyed by source time.
  `source` cannot hash a live URL, so the tool must also record what was captured:
  - the URL, the date, the viewport, the seed, `rafHz` and `fps`;
  - the sha256 of every response it loaded (or the saved page);
  - its own version.

  A second capture that differs is then explained, not silent.
- **Optional in core.** Export `chromePath` from `shaderera` (or document `CHROME` as the
  contract), so the plugin and `doctor` always agree on which Chrome. Nothing else: no capture
  command, no CDP API, no new format number.

## Experiments, 2026-11-04

Run on macOS with Chrome 156.0.8078.80, `--headless=new`, a throwaway profile, and
`Page.addScriptToEvaluateOnNewDocument`. Pages used GSAP 3.15.1, motion 12.43.0 and
@react-spring/web 9.7.5. Each frame read every tracked element's rect, computed `transform`
and `opacity` after the clock had advanced. The harness lived in a scratch folder and was not
kept.

**`clock.js` as published is not deterministic.**
- GSAP's tracks differed by up to 4 px between a normal run and a 6× CPU-throttled run.
  - `Date.now` rounds `dateOffset + now`, and both parts carry the real clock's fraction.
  - GSAP's 1 ms deltas therefore came out 17/17/16 in one run and 16/17/17 in another.
- motion's WAAPI opacity differed between two plain runs.
  - An animation first seen while frozen starts from its real `currentTime`, not from 0.
- A JS animation trailed CSS by one rAF tick, even with `rafHz` equal to the fps.
  - `nextTick` accumulates floating-point error, so a tick due at a frame's time lands just
    after it, and that frame skips it.

**Three fixes, each a line or two:**
1. Freeze on a whole millisecond, with a whole-millisecond `dateOffset`.
2. An animation first seen while frozen starts at 0. A `sync()` runs after each timer callback
   and after each input, so an animation is caught on the virtual time it started.
3. Tick `n` falls at `t0 + n · tick`, counted from the freeze, and a tick due at the target
   runs.

**Results with the fixes:**

| # | Experiment | Result |
|---|---|---|
| 1 | GSAP (`power3.out`, `elastic`, linear), motion (spring `x`, WAAPI opacity, spring with bounce), react-spring (spring, duration). Normal runs against 4× and 6× throttled runs | Byte-identical tracks in every pair. Five runs per library gave one hash each |
| 2 | Repeats of the same page | Byte-identical |
| 3 | A CSS transition and a motion `animate()`, both started by a click at 500 ms | Both start on the first frame after the click and end at 1.1 s. The CSS track matches the `cubic-bezier(.16,1,.3,1)` formula within 0.0004 px. Three runs, one throttled 6×, were identical |
| 4 | A CSS linear move and a GSAP linear move of the same span, at several fps and `rafHz` | When `rafHz` is a multiple of the fps (24/24, 24/48, 25/25, 30/60, 60/60), JS matches CSS within 0.33 ms, which is GSAP's whole-ms `Date.now`. At 24 fps with `rafHz` 60, JS trails by up to 8.7 ms |
| 5 | CDP `setVirtualTimePolicy` with no injected clock | The call is accepted. `pause` stops `performance.now`, `Date` and rAF, and `advance` moves exactly the budget. But rAF ran every 16.6 ms in one run and 33.4 ms in the next, CSS and JS values stalled for several frames (up to 167 ms apart), and a 6× throttled run hung |
| 6 | A worker that steps a position, and a canvas drawn from `performance.now` in rAF | Both identical across runs and under 6× throttling. The worker's arithmetic does not read its own clock: a worker that reads time is still not covered |

So:
- **Port `clock.js` with the three fixes.** Do not use CDP virtual time.
- **Set `rafHz` to a multiple of the capture fps**, by default equal to it.
- The maintainer's "not supported in new headless" is half true: the call works, and it gives no
  usable frame timing.

## Open

- **Other platforms.** The experiments ran on macOS only. Windows and Linux Chrome are untested.
- **Workers that read time.** Answered (#667): the clock goes into each dedicated worker over
  `Target.setAutoAttach` with `waitForDebuggerOnStart`, at an instrumentation breakpoint before
  its first script (paused at its start, a worker's global has no `setTimeout` yet). The page's
  clock drives it, and a reply lands at the time its question was sent. Shared workers stay on
  real time.
- **Real sites.** Only test pages were captured, not production bundles with lazy loading,
  scroll-linked motion or third-party scripts.
- **Workers and iframes.** Answered (#667): the page's script reaches the frames of its own
  process (a window that keeps its first empty document's global gets a new `document`, so the
  clock reads it each time). A frame of another site needs `Target.setAutoAttach`, then
  `Page.enable` and the script on its own session before it runs. An OffscreenCanvas a worker
  draws, and a paused `<video>` seeked once and then waited on with `requestVideoFrameCallback`,
  show the frame at the virtual time; a paused video seeked again before its last frame was
  presented, or one held at `playbackRate` 0, showed an earlier frame.
- **reanimate's own scripts** were not run. Only its `clock.js` was, in our harness.
- **Playwright's clock.** Its licence (Apache-2.0) and whether reusing its timer code would be
  simpler than `clock.js`. Not compared in depth.
