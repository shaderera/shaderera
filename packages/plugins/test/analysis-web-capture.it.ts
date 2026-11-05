// analysis-web-capture, in the machine's own Chrome: the research's experiments as tests. Pages
// in test/web-capture/libraries/ run GSAP, motion and react-spring themselves (exact versions,
// devDependencies bundled here by esbuild); the other pages in test/web-capture/ copy their
// clocks and clamps by hand, and add CSS, Web Animations, absolute time and animations started
// off a timer. Two captures give the same bytes, but for source.date; a capture under 6x CPU
// throttling gives the same bytes as one without; with rafHz equal to the fps, a JS linear move
// on GSAP's ticker matches a CSS one within 0.5 ms. A click at 500 ms starts a CSS transition and
// motion's animate() on the first frame after it, the transition on its cubic-bezier within
// 0.001 px; hover, leave and scroll capture the same at any speed, scroll against scrollY, the
// wheel hovering what it turns over; a click that navigates, and a target with no box, are
// refused; the declared animations keep their keyframes and easing strings; --settle loaded runs
// the load on real time. A page that reaches for this machine is refused without --allow-local,
// and the local server sees nothing; with it, each response is hashed as served. A still of a page
// with a web font, a Thai line it falls back from and a shadowed card gives the families and glyph
// counts, boxes within 0.5 px and the computed values, the same bytes and screenshot each time;
// a still after a scroll has its boxes from the viewport and the scroll recorded. A motion capture
// names the system font a tracked title in a missing family fell back to.
// Workers (classic and module) and frames (of this origin, of another site, added later) run on
// the clock: their timers, animation frames, Date and replies land at the page's times; an
// OffscreenCanvas a worker draws and a video show the frame at the still's time, pixel for pixel.
// A frame of another site sees the page's locale. A worker that ends itself is let go. A shared
// worker, a BroadcastChannel, a MessagePort sent to a worker or a frame, a frame that messages its
// sibling, a video its server cannot seek and one that cannot play are limits, named in the file
// and by the CLI. Skipped, with the reason, when there is no Chrome.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { type Host, sha256 } from '@shaderera/core'
import { build } from 'esbuild'
import { decode as decodePng } from 'fast-png'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'analysis-web-capture.it')
rmSync(project, { recursive: true, force: true })
for (const item of ['analysis-reference-tracks', 'analysis-web-capture']) {
  const label = JSON.parse(readFileSync(join(plugins, item, 'shaderera.item.json'), 'utf8')) as {
    files: string[]
  }
  for (const f of label.files) {
    mkdirSync(dirname(join(project, f)), { recursive: true })
    cpSync(join(plugins, item, f), join(project, f))
  }
}
const from = (p: string) => import(pathToFileURL(join(project, p)).href)
const { captureWeb, chromePath } = (await from(
  'tools/capture-web.ts',
)) as typeof import('../analysis-web-capture/tools/capture-web.ts')
const { loadTracks, track } = (await from(
  'src/reference/tracks.ts',
)) as typeof import('../analysis-reference-tracks/src/reference/tracks.ts')
const { loadStyle, styleOf, textsOf } = (await from(
  'src/reference/style.ts',
)) as typeof import('../analysis-web-capture/src/reference/style.ts')
type Options = import('../analysis-web-capture/tools/capture-web.ts').CaptureOptions
type Doc = import('../analysis-reference-tracks/src/reference/tracks.ts').ReferenceTracks

const chrome = await chromePath()
const skip =
  chrome && existsSync(chrome)
    ? false
    : 'no Chrome on this machine: install Google Chrome, or set CHROME to its path'
const fixture = (name: string) => join(import.meta.dirname, 'web-capture', name)

// Each library page with its bundle beside it, built once.
const libraries = join(project, 'libraries')
mkdirSync(libraries, { recursive: true })
for (const name of ['gsap', 'motion', 'spring', 'click']) {
  cpSync(fixture(`libraries/${name}.html`), join(libraries, `${name}.html`))
  await build({
    entryPoints: [fixture(`libraries/${name}.js`)],
    bundle: true,
    format: 'iife',
    outfile: join(libraries, `${name}.bundle.js`),
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
  })
}
const library = (name: string) => join(libraries, `${name}.html`)
const outs = mkdtempSync(join(tmpdir(), 'shaderera-web-capture-test-'))
let n = 0

const capture = async (o: Partial<Options> & Pick<Options, 'page' | 'track'>) => {
  const { json } = await captureWeb({
    out: join(outs, String(n++)),
    fps: 30,
    rafHz: o.fps ?? 30,
    duration: 1.6,
    viewport: { width: 800, height: 400 },
    ...o,
  })
  return json
}
/** The bytes of a capture with its one line that names the time it ran left out. */
const undated = (json: string) => {
  const lines = json.split('\n')
  const dated = lines.filter((l) => /^ {4}"date": "[^"]+",$/.test(l))
  assert.equal(dated.length, 1, 'a capture has one date')
  return lines.filter((l) => !dated.includes(l)).join('\n')
}
const samplesOf = (json: string, element: string, channel: string) =>
  ((JSON.parse(json) as Doc).tracks.find((t) => t.element === element && t.channel === channel)
    ?.samples ?? []) as [number, number | null][]

/** The same page captured plainly, again, and at 6x CPU throttling: the same bytes each time. */
const sameEveryTime = async (page: string, trackList: string[], more: Partial<Options> = {}) => {
  const first = await capture({ page, track: trackList, ...more })
  const again = await capture({ page, track: trackList, ...more })
  const slow = await capture({ page, track: trackList, ...more, cpuThrottle: 6 })
  assert.equal(undated(again), undated(first), 'a repeat gives the same bytes')
  assert.equal(undated(slow), undated(first), 'a 6x throttled capture gives the same bytes')
  return first
}

test('GSAP captures the same at any speed, and its ticker matches CSS within 0.5 ms', {
  skip,
}, async () => {
  const json = await sameEveryTime(library('gsap'), ['#a', '#b', '#lin', '#css'])
  const lin = samplesOf(json, '#lin', 'translateX')
  const css = samplesOf(json, '#css', 'translateX')
  // 600 px in 2000 ms: 0.3 px a millisecond.
  let worst = 0
  css.forEach(([, v], i) => {
    worst = Math.max(worst, Math.abs((v as number) - (lin[i]?.[1] as number)) / 0.3)
  })
  assert.ok(worst <= 0.5, `GSAP's ticker is ${worst.toFixed(3)} ms off CSS`)
  const a = samplesOf(json, '#a', 'translateX')
  assert.equal(a.find(([t]) => t === 0.2)?.[1], 0, '#a waits for its 0.2 s delay')
  assert.ok((a.find(([t]) => t === 0.3)?.[1] as number) > 0, '#a moves after it')
  assert.equal(samplesOf(json, '#b', 'translateX').at(-1)?.[1], 400)
})

test('motion captures the same at any speed, with the fade it hands to WAAPI declared', {
  skip,
}, async () => {
  const json = await sameEveryTime(library('motion'), ['#a', '#b', '#c'])
  const doc = JSON.parse(json) as Doc
  const fade = doc.declared.find((d) => d.element === '#b')
  assert.equal(fade?.type, 'web-animation')
  const start = fade?.start as number
  assert.ok(start >= 0 && start < 0.1, `the fade was first seen at ${start} s`)
  // Linear over 1 s from its start: the samples and the declared start agree.
  for (const [t, v] of samplesOf(json, '#b', 'opacity'))
    if (t > start && t < start + 1)
      assert.ok(Math.abs((v as number) - (t - start)) < 1e-3, `#b at ${t} s is ${v}`)
  assert.ok(Math.abs((samplesOf(json, '#a', 'translateX').at(-1)?.[1] as number) - 400) < 1)
})

test('react-spring in React 18 captures the same at any speed', { skip }, async () => {
  const json = await sameEveryTime(library('spring'), ['#a', '#b'])
  const x = samplesOf(json, '#a', 'translateX')
  assert.ok((x.find(([t]) => t === 0.2)?.[1] as number) > 0, 'the spring moves')
  assert.ok(Math.abs((x.at(-1)?.[1] as number) - 400) < 1, `it settles at ${x.at(-1)?.[1]}`)
  assert.equal(samplesOf(json, '#b', 'opacity').at(-1)?.[1], 1)
})

test('a page that reads absolute time gets the same values on every run', { skip }, async () => {
  const json = await sameEveryTime(fixture('absolute.html'), ['#perf', '#ts', '#date', '#hours'])
  const doc = JSON.parse(json) as Doc
  assert.equal(doc.params.timeOrigin, 0)
  assert.equal(doc.params.clockDate, '2000-01-01T00:00:00.000Z')
  assert.equal(doc.params.timezone, 'UTC')
  // From the freeze: performance.now and the frame's timestamp read its time, Date whole ms.
  const at = (el: string, t: number) =>
    samplesOf(json, el, 'translateX').find(([s]) => s === t)?.[1]
  assert.equal(at('#perf', 0.1), 30)
  assert.equal(at('#ts', 0.1), 30)
  assert.equal(at('#date', 0.033333), 9.9)
  assert.equal(at('#hours', 1), 0)
  const moved = JSON.parse(
    await capture({
      page: fixture('absolute.html'),
      track: ['#perf', '#date', '#hours'],
      timeOrigin: 1000,
      clockDate: '2026-11-04T19:00:00+07:00',
      timezone: 'Asia/Bangkok',
    }),
  ) as Doc
  assert.equal(moved.params.clockDate, '2026-11-04T12:00:00.000Z')
  const atMoved = (el: string) =>
    samplesOf(JSON.stringify(moved), el, 'translateX').find(([s]) => s === 0.1)?.[1]
  assert.equal(atMoved('#perf'), 330)
  assert.equal(atMoved('#hours'), 19)
})

test('the locale and the seed are held and recorded, and seed 0 is a seed of its own', {
  skip,
}, async () => {
  const run = async (o: Partial<Options>) =>
    JSON.parse(
      await capture({
        page: fixture('locale.html'),
        track: ['#lang', '#random'],
        duration: 0.1,
        ...o,
      }),
    ) as Doc
  const first = (doc: Doc, el: string) =>
    doc.tracks.find((t) => t.element === el && t.channel === 'translateX')?.samples[0]?.[1]
  const plain = await run({})
  assert.equal(plain.params.locale, 'en-US')
  assert.equal(first(plain, '#lang'), 0)
  const thai = await run({ locale: 'th-TH' })
  assert.equal(thai.params.locale, 'th-TH')
  assert.equal(first(thai, '#lang'), 3, 'navigator.language and Intl both see the locale')
  const zero = await run({ seed: 0 })
  assert.equal(zero.params.seed, 0)
  assert.notEqual(first(zero, '#random'), first(plain, '#random'), 'seed 0 is not seed 1')
})

test('an animation started in a frame or a promise starts at its own time', {
  skip,
}, async () => {
  // rafHz twice the fps: the first frame runs between captured frames.
  const json = await capture({
    page: fixture('late-start.html'),
    track: ['#raf-waapi', '#raf-js', '#promise'],
    rafHz: 60,
    duration: 0.5,
  })
  const waapi = samplesOf(json, '#raf-waapi', 'translateX')
  assert.deepEqual(waapi, samplesOf(json, '#raf-js', 'translateX'))
  assert.equal(waapi.find(([t]) => t === 0.033333)?.[1], 16.6667)
  const promise = samplesOf(json, '#promise', 'translateX')
  assert.equal(promise.find(([t]) => t === 0.1)?.[1], 0)
  assert.equal(promise.find(([t]) => t === 0.133333)?.[1], 23.3333)
  const doc = JSON.parse(json) as Doc
  assert.equal(doc.declared.find((d) => d.element === '#promise')?.start, 0.11)
  const rafStart = doc.declared.find((d) => d.element === '#raf-waapi')?.start as number
  assert.ok(Math.abs(rafStart - 1 / 60) < 1e-9, `#raf-waapi was first seen at ${rafStart} s`)
})

test('a percentage translate is of the unrounded border box, and unread on SVG', {
  skip,
}, async () => {
  const json = await capture({
    page: fixture('percent.html'),
    track: ['#content', '#border', '#svg'],
    fps: 10,
    duration: 0.1,
  })
  assert.equal(samplesOf(json, '#content', 'translateX')[0]?.[1], 60.25)
  assert.equal(samplesOf(json, '#border', 'translateX')[0]?.[1], 50.25)
  assert.equal(samplesOf(json, '#border', 'x')[0]?.[1], 58.25)
  const doc = JSON.parse(json) as Doc
  assert.ok(doc.limits.some((l) => l.where === '#svg' && /translate 50%/.test(l.reason)))
})

test('a GSAP-style ticker (Date.now, lag smoothing) captures the same at any speed', {
  skip,
}, async () => {
  const json = await sameEveryTime(fixture('ticker.html'), ['#a', '#b', '#lin'])
  const lin = samplesOf(json, '#lin', 'translateX')
  // Linear, 400 px in 1 s: at 0.5 s it is halfway, within GSAP's whole-ms Date.now.
  const half = lin.find(([t]) => t === 0.5)?.[1] as number
  assert.ok(Math.abs(half - 200) <= 0.4 * 0.5, `#lin at 0.5 s is ${half}`)
  const a = samplesOf(json, '#a', 'translateX')
  assert.equal(a.find(([t]) => t === 0.2)?.[1], 0, '#a waits for its 0.2 s delay')
  assert.equal(a.at(-1)?.[1], 400)
})

test('springs on performance.now, WAAPI and CSS transitions capture the same at any speed', {
  skip,
}, async () => {
  const json = await sameEveryTime(fixture('spring.html'), ['#a', '#b', '#c', '#d'])
  const doc = JSON.parse(json) as Doc
  // The fade a timer starts at 0.3 s starts there, from 0, and runs 1 s.
  const c = samplesOf(json, '#c', 'opacity')
  assert.equal(c.find(([t]) => t === 0.3)?.[1], 0)
  assert.ok(Math.abs((c.find(([t]) => t === 0.8)?.[1] as number) - 0.5) < 1e-3)
  // The transition's turn keeps counting past 180 degrees and ends at 270.
  const rotate = samplesOf(json, '#d', 'rotate')
  assert.equal(rotate.at(-1)?.[1], 270)
  assert.ok(rotate.every(([, v], i) => i === 0 || (v as number) >= (rotate[i - 1]?.[1] as number)))
  // What the page declared is kept as it declared it.
  const translate = doc.declared.find((d) => d.element === '#d' && d.property === 'translate')
  assert.equal(translate?.type, 'css-transition')
  assert.equal(translate?.start, 0.5)
  assert.equal(
    (translate?.timing as { easing?: string } | undefined)?.easing,
    'cubic-bezier(0.16, 1, 0.3, 1)',
  )
  const fade = doc.declared.find((d) => d.element === '#c')
  assert.equal(fade?.type, 'web-animation')
  assert.equal(fade?.start, 0.3)
})

test('with rafHz equal to the fps, a JS linear move matches a CSS one within 0.5 ms', {
  skip,
}, async () => {
  for (const [fps, rafHz] of [
    [30, 30],
    [24, 24],
    [24, 48],
    [25, 25],
  ] as const) {
    const json = await capture({
      page: fixture('linear.html'),
      track: ['#css', '#js'],
      fps,
      rafHz,
      duration: 2.2,
    })
    const css = samplesOf(json, '#css', 'translateX')
    const js = samplesOf(json, '#js', 'translateX')
    // 600 px in 2000 ms: 0.3 px a millisecond.
    let worst = 0
    css.forEach(([t, v], i) => {
      if (t > 2) return
      worst = Math.max(worst, Math.abs((v as number) - (js[i]?.[1] as number)) / 0.3)
    })
    assert.ok(worst <= 0.5, `${fps} fps, rafHz ${rafHz}: JS is ${worst.toFixed(3)} ms off CSS`)
    assert.equal(css.find(([t]) => t === 1)?.[1], 300)
  }
})

/** A CSS cubic-bezier(x1, y1, x2, y2) at progress p, solved by bisection to the last bit. */
const cubicBezier = (x1: number, y1: number, x2: number, y2: number) => (p: number) => {
  const at = (a: number, b: number, s: number) =>
    3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s ** 2 * b + s ** 3
  let lo = 0
  let hi = 1
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (at(x1, x2, mid) < p) lo = mid
    else hi = mid
  }
  return at(y1, y2, (lo + hi) / 2)
}

test("a click at 500 ms starts a CSS transition and motion's animate() on the first frame after it", {
  skip,
}, async () => {
  const json = await sameEveryTime(library('click'), ['#css', '#motion', '#fade'], {
    trigger: 'click',
    target: '#button',
    at: 500,
  })
  const doc = JSON.parse(json) as Doc
  assert.deepEqual(doc.params.trigger, {
    type: 'click',
    target: '#button',
    at: 500,
    pointer: { x: 660, y: 330 },
  })
  assert.equal(doc.params.settle, 'load')
  for (const el of ['#css', '#motion']) {
    const x = samplesOf(json, el, 'translateX')
    // Frame k is at k / 30 s: the click is on frame 15, and the motion shows on frame 16.
    assert.ok(
      x.slice(0, 16).every(([, v]) => v === 0),
      `${el} is still until the click`,
    )
    assert.ok((x[16]?.[1] as number) > 0, `${el} moves on the first frame after the click`)
    assert.equal(x.at(-1)?.[1], 300)
  }
  // The transition is its cubic-bezier from the click, within 0.001 px at every frame.
  const ease = cubicBezier(0.3, 0, 0.2, 1)
  let worst = 0
  samplesOf(json, '#css', 'translateX').forEach(([, v], k) => {
    const p = Math.min(1, Math.max(0, (k / 30 - 0.5) / 1))
    worst = Math.max(worst, Math.abs((v as number) - 300 * ease(p)))
  })
  assert.ok(worst <= 0.001, `the transition is ${worst} px off its cubic-bezier`)
  const transition = doc.declared.find((d) => d.element === '#css')
  assert.equal(transition?.type, 'css-transition')
  assert.equal(transition?.start, 0.5)
  assert.equal(
    (transition?.timing as { easing?: string } | undefined)?.easing,
    'cubic-bezier(0.3, 0, 0.2, 1)',
  )
  // motion hands its fade to the Web Animations API on its next frame, the first after the click.
  const fade = doc.declared.find((d) => d.element === '#fade')
  assert.equal(fade?.type, 'web-animation')
  assert.ok(
    Math.abs((fade?.start as number) - 16 / 30) < 1e-9,
    `the fade started at ${fade?.start}`,
  )
  assert.deepEqual(doc.limits, [])
})

test('declared holds the keyframes, timing and easing strings as the page wrote them', {
  skip,
}, async () => {
  const doc = JSON.parse(
    await capture({ page: fixture('declared.html'), track: ['#css', '#waapi'], duration: 0.3 }),
  ) as Doc
  const of = (element: string) => doc.declared.filter((d) => d.element === element)
  const [css] = of('#css')
  assert.equal(of('#css').length, 1, 'each animation once')
  assert.equal(css?.type, 'css-animation')
  assert.equal(css?.name, 'pulse')
  assert.deepEqual(css?.timing, {
    delay: 250,
    direction: 'alternate',
    duration: 2000,
    easing: 'linear',
    endDelay: 0,
    fill: 'both',
    iterationStart: 0,
    iterations: 3,
  })
  // A CSS animation's own timing function is each keyframe's easing until one sets its own.
  assert.deepEqual(
    ((css?.keyframes ?? []) as Record<string, unknown>[]).map(({ offset, easing, scale }) => ({
      offset,
      easing,
      scale,
    })),
    [
      { offset: 0, easing: 'steps(4, jump-start)', scale: '1' },
      { offset: 0.4, easing: 'cubic-bezier(0.1, 0.7, 1, 0.1)', scale: '1.5' },
      { offset: 1, easing: 'cubic-bezier(0.68, -0.6, 0.32, 1.6)', scale: '1' },
    ],
  )
  const [waapi] = of('#waapi')
  assert.equal(waapi?.type, 'web-animation')
  assert.equal(waapi?.id, 'slide')
  assert.equal(waapi?.start, 0)
  assert.deepEqual(waapi?.timing, {
    delay: 100,
    direction: 'alternate-reverse',
    duration: 1200,
    easing: 'cubic-bezier(0.42, 0, 0.58, 1)',
    endDelay: 50,
    fill: 'forwards',
    iterationStart: 0.5,
    iterations: 'infinite',
  })
  assert.deepEqual(waapi?.keyframes, [
    { composite: 'auto', computedOffset: 0, easing: 'ease-in', offset: null, translate: '0px' },
    {
      composite: 'auto',
      computedOffset: 0.3,
      easing: 'steps(2, jump-none)',
      offset: 0.3,
      translate: '100px',
    },
    { composite: 'add', computedOffset: 1, easing: 'linear', offset: null, translate: '200px' },
  ])
  // An element no --track names is declared too, named by a selector, with its pseudo-element.
  const blink = doc.declared.find((d) => d.name === 'blink')
  assert.equal(blink?.element, '#untracked')
  assert.equal(blink?.pseudoElement, '::after')
  assert.equal((blink?.timing as { iterations?: unknown } | undefined)?.iterations, 'infinite')
})

test('a hover and a leave capture the same at any speed', { skip }, async () => {
  const card = ['#card', '#badge', '#note']
  const hover = await sameEveryTime(fixture('hover.html'), card, {
    trigger: 'hover',
    target: '#card',
    at: 300,
    duration: 1,
  })
  const opacity = samplesOf(hover, '#card', 'opacity')
  assert.equal(opacity.find(([t]) => t === 0.3)?.[1], 0.5, 'the card waits for the pointer')
  assert.equal(opacity.find(([t]) => t === 0.333333)?.[1], 0.5556)
  assert.equal(opacity.find(([t]) => t === 0.6)?.[1], 1)
  assert.equal(samplesOf(hover, '#card', 'translateY').at(-1)?.[1], -20)
  const hovered = JSON.parse(hover) as Doc
  assert.deepEqual(hovered.params.trigger, {
    type: 'hover',
    target: '#card',
    at: 300,
    pointer: { x: 200, y: 160 },
  })
  // The mouseenter handler's animation and the timer it set start at their own times.
  const start = (doc: Doc, element: string) =>
    doc.declared.filter((d) => d.element === element).map((d) => d.start)
  assert.deepEqual(start(hovered, '#badge'), [0.3])
  assert.deepEqual(start(hovered, '#note'), [0.5])

  const leave = await sameEveryTime(fixture('hover.html'), card, {
    trigger: 'leave',
    target: '#card',
    at: 800,
    duration: 1.5,
  })
  const left = JSON.parse(leave) as Doc
  assert.deepEqual((left.params.trigger as { leftTo?: unknown }).leftTo, { x: -1, y: -1 })
  // Over the card from 0 ms, off it at 800.
  assert.deepEqual(start(left, '#badge'), [0, 0.8])
  assert.deepEqual(start(left, '#note'), [0.2, 1])
  const back = samplesOf(leave, '#card', 'opacity')
  assert.equal(back.find(([t]) => t === 0.8)?.[1], 1)
  assert.equal(back.find(([t]) => t === 0.833333)?.[1], 0.9444)
  assert.equal(back.at(-1)?.[1], 0.5)
})

test('a scroll at 24 fps, whose wheel times round past a frame, still captures', {
  skip,
}, async () => {
  // A wheel at 208.33333333333334 ms goes with the frame at 208.33333333333331, not after it.
  const json = await capture({
    page: fixture('scroll.html'),
    track: ['#js'],
    fps: 24,
    duration: 0.6,
    trigger: 'scroll',
    at: 0,
    scrollTo: 240,
    scrollMs: 500,
  })
  const y = samplesOf(json, 'window', 'scrollY')
  assert.equal(y.at(-1)?.[1], 240)
  assert.deepEqual((JSON.parse(json) as Doc).limits, [])
})

test('a scroll is recorded against scrollY and captures the same at any speed', {
  skip,
}, async () => {
  const json = await sameEveryTime(fixture('scroll.html'), ['#js', '#css', '#inline'], {
    trigger: 'scroll',
    at: 200,
    scrollTo: 600,
    scrollMs: 300,
    duration: 1,
  })
  const doc = JSON.parse(json) as Doc
  assert.deepEqual(doc.params.trigger, {
    type: 'scroll',
    at: 200,
    scrollTo: 600,
    scrollMs: 300,
    pointer: { x: 400, y: 200 },
    // No --target: what the wheel's point hovered is named.
    over: 'body',
  })
  const y = samplesOf(json, 'window', 'scrollY')
  assert.ok(
    y.filter(([t]) => t <= 0.2).every(([, v]) => v === 0),
    'still until 200 ms',
  )
  assert.ok(
    y.filter(([t]) => t >= 0.5).every(([, v]) => v === 600),
    'at 600 from 500 ms',
  )
  // One wheel event each 1/30 s, on a straight line in whole pixels.
  assert.deepEqual(
    y.filter(([t]) => t > 0.2 && t < 0.5).map(([, v]) => v),
    [67, 133, 200, 267, 333, 400, 467, 533],
  )
  assert.ok(samplesOf(json, 'window', 'scrollX').every(([, v]) => v === 0))
  y.forEach(([t, s], i) => {
    const sy = s as number
    assert.equal(samplesOf(json, '#js', 'translateX')[i]?.[1], sy / 2, `the listener at ${t} s`)
    assert.equal(samplesOf(json, '#inline', 'y')[i]?.[1], 100 - sy, `the page at ${t} s`)
    const scale = samplesOf(json, '#css', 'scaleX')[i]?.[1] as number
    assert.ok(Math.abs(scale - (1 + (2 * sy) / 2600)) < 1e-4, `the scroll timeline at ${t} s`)
  })
  const timeline = doc.declared.find((d) => d.element === '#css')
  assert.deepEqual(timeline?.timeline, { type: 'scroll', source: 'window', axis: 'block' })
  assert.deepEqual(doc.limits, [])

  // A scroll past the page's end is what the page did, and says so.
  const far = JSON.parse(
    await capture({
      page: fixture('scroll.html'),
      track: ['#js'],
      trigger: 'scroll',
      at: 0,
      scrollTo: 5000,
      scrollMs: 0,
      duration: 0.1,
    }),
  ) as Doc
  assert.equal(samplesOf(JSON.stringify(far), 'window', 'scrollY').at(-1)?.[1], 2600)
  assert.ok(
    far.limits.some(
      (l) => l.where === 'window' && /scrolled to 2600, not --scroll-to 5000/.test(l.reason),
    ),
  )
})

test('the wheel hovers what it turns over, as a person does', { skip }, async () => {
  const json = await sameEveryTime(fixture('hover-scroll.html'), ['#r5', '#r15'], {
    trigger: 'scroll',
    at: 100,
    scrollTo: 400,
    scrollMs: 300,
    duration: 0.6,
  })
  const r5 = samplesOf(json, '#r5', 'opacity')
  const r15 = samplesOf(json, '#r15', 'opacity')
  assert.equal(r5.find(([t]) => t === 0.1)?.[1], 1, 'over #r5 when the scroll starts')
  assert.equal(r5.at(-1)?.[1], 0.5)
  assert.equal(r15.at(-1)?.[1], 1, 'over #r15 where the scroll ends')
})

test('a capture holds one document: an input that navigates is refused', { skip }, async () => {
  const page = fixture('nav.html')
  const options = {
    out: join(outs, String(n++)),
    track: ['#box'],
    fps: 10,
    rafHz: 10,
    duration: 0.6,
  }
  const viewport = { width: 800, height: 400 }
  await assert.rejects(
    captureWeb({ page, ...options, viewport, trigger: 'click', target: '#go', at: 200 }),
    /the page navigated to file:.*nav-away\.html after the click at 200 ms: a capture holds one document/,
  )
  // A target with no box has no centre to send the pointer to.
  await assert.rejects(
    captureWeb({ page, ...options, viewport, trigger: 'click', target: '#hidden', at: 200 }),
    /--target "#hidden" has no box at 200 ms \(display: none\?\), so the pointer cannot reach it/,
  )
})

test('--settle loaded runs timers on real time until the load event, then freezes', {
  skip,
}, async () => {
  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': 6 })
      res.end('void 0')
    }, 300)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  try {
    const page = `${pathToFileURL(fixture('loaded.html')).href}?port=${port}`
    const track = ['#early', '#moved', '#late']
    const frozen = JSON.parse(
      await capture({ page, track, allowLocal: true, duration: 0.3 }),
    ) as Doc
    assert.equal(frozen.params.settle, 'load')
    assert.equal('loadedAt' in frozen.source, false)
    const at = (doc: Doc, el: string, t: number) =>
      samplesOf(JSON.stringify(doc), el, 'translateX').find(([s]) => s === t)?.[1]
    assert.equal(at(frozen, '#moved', 0), 0, 'frozen from the first script, the timer waits')
    assert.equal(at(frozen, '#moved', 0.1), 50)
    assert.equal(frozen.declared.find((d) => d.element === '#early')?.start, 0.05)

    const loaded = JSON.parse(
      await capture({ page, track, allowLocal: true, duration: 0.3, settle: 'loaded' }),
    ) as Doc
    assert.equal(loaded.params.settle, 'loaded')
    const loadedAt = (loaded.source as { loadedAt?: number }).loadedAt as number
    assert.ok(loadedAt >= 0.3, `the load took ${loadedAt} s`)
    assert.equal(at(loaded, '#moved', 0), 50, 'the timers ran while the page loaded')
    // Time is from the freeze: the fade began before it, the load handler's move at it.
    const early = loaded.declared.find((d) => d.element === '#early')?.start as number
    assert.ok(Math.abs(early - (0.05 - loadedAt)) < 0.0015, `the fade began at ${early} s`)
    assert.equal(loaded.declared.find((d) => d.element === '#late')?.start, 0)
    assert.equal(at(loaded, '#late', 0.1), 10)
  } finally {
    server.close()
  }
})

test('the capture is read by the reader of reference tracks', { skip }, async () => {
  const out = join(outs, 'read')
  const { path } = await captureWeb({
    page: fixture('linear.html'),
    out,
    track: ['#css', '#missing'],
    fps: 10,
    rafHz: 10,
    duration: 0.5,
    viewport: { width: 640, height: 360 },
  })
  const host = { io: { read: async (p: string) => new Uint8Array(readFileSync(p)) } } as Host
  const doc = await loadTracks(host, path)
  assert.deepEqual(doc.frame, { width: 640, height: 360, pixelRatio: 1 })
  assert.equal(track(doc, '#css', 'x').samples.length, 6)
  assert.ok(track(doc, '#missing', 'x').samples.every(([, v]) => v === null))
  assert.ok(doc.limits.some((l) => l.where === '#missing' && /no element/.test(l.reason)))
  assert.equal(doc.params.rafHz, 10)
  assert.match(String(doc.tool.chrome), /^(Chrome|HeadlessChrome)\//)
  // The page itself is a response, hashed as its bytes.
  const hash = await sha256(new Uint8Array(readFileSync(fixture('linear.html'))))
  assert.ok(
    'responses' in doc.source &&
      doc.source.responses.some((r) => r.url.endsWith('linear.html') && r.sha256 === hash),
  )
})

test('a page that reaches for this machine is refused unless --allow-local', { skip }, async () => {
  const hits: string[] = []
  const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]) // "café" in ISO-8859-1
  const noise = new Uint8Array(4096).map((_, i) => (i * 7919 + 13) % 251)
  const server = createServer((req, res) => {
    hits.push(req.url ?? '')
    const cors = { 'access-control-allow-origin': '*' }
    const text = { ...cors, 'content-type': 'text/plain; charset=iso-8859-1' }
    const png = { ...cors, 'content-type': 'image/png' }
    if (req.url === '/latin1') {
      res.writeHead(200, { ...text, 'content-length': latin1.length })
      res.end(latin1)
    } else if (req.url === '/latin1-chunked') {
      res.writeHead(200, text)
      res.write(latin1)
      res.end()
    } else if (req.url === '/bad.png') {
      res.writeHead(200, { ...png, 'content-length': noise.length })
      res.end(noise)
    } else if (req.url === '/bad-chunked.png') {
      res.writeHead(200, png)
      res.write(noise)
      res.end()
    } else {
      res.writeHead(200, { ...cors, 'content-type': 'text/plain' })
      res.end(`body of ${req.url}`)
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  try {
    const page = `${pathToFileURL(fixture('local.html')).href}?port=${port}`
    const refused = JSON.parse(
      await capture({ page, track: ['#box'], fps: 10, duration: 0.3 }),
    ) as Doc
    assert.deepEqual(hits, [], 'nothing reached the local server')
    const reasons = refused.limits.map((l) => `${l.where} ${l.reason}`).join('\n')
    assert.match(reasons, /127\.0\.0\.1.*refused: 127\.0\.0\.1 is a loopback address/)
    assert.match(reasons, /localhost.*refused: localhost is a loopback name/)
    assert.equal(refused.params.allowLocal, false)

    const allowed = JSON.parse(
      await capture({ page, track: ['#box'], fps: 10, duration: 0.3, allowLocal: true }),
    ) as Doc
    assert.deepEqual([...hits].sort(), [
      '/bad-chunked.png',
      '/bad.png',
      '/latin1',
      '/latin1-chunked',
      '/pixel',
      '/secret',
    ])
    assert.ok('responses' in allowed.source)
    const response = (path: string) => {
      const found =
        'responses' in allowed.source
          ? allowed.source.responses.filter((r) => new URL(r.url).pathname === path)
          : []
      assert.equal(found.length <= 1, true, `${path} is listed once`)
      return found[0]
    }
    const secret = await sha256(new TextEncoder().encode('body of /secret'))
    assert.equal(response('/secret')?.sha256, secret)
    // A body of a known length is hashed as its bytes were served, whatever its charset.
    assert.equal(response('/latin1')?.sha256, await sha256(latin1))
    assert.equal(response('/latin1')?.hashOf, undefined)
    assert.equal(response('/bad.png')?.sha256, await sha256(noise))
    // Without a length it is read at its end: text as Chrome decoded it, said so.
    assert.equal(response('/latin1-chunked')?.hashOf, 'text-as-utf8')
    assert.equal(
      response('/latin1-chunked')?.sha256,
      await sha256(new TextEncoder().encode('café')),
    )
    // An image Chrome could not decode and did not keep is a limit, not the hash of nothing.
    assert.equal(response('/bad-chunked.png'), undefined)
    assert.ok(
      allowed.limits.some(
        (l) => l.where.endsWith('/bad-chunked.png') && /not kept by Chrome/.test(l.reason),
      ),
    )

    // A page served from this machine is refused before Chrome starts.
    await assert.rejects(
      captureWeb({
        page: `http://127.0.0.1:${port}/`,
        out: join(outs, 'local-page'),
        track: ['#box'],
        fps: 10,
        rafHz: 10,
        duration: 0.3,
        viewport: { width: 800, height: 400 },
      }),
      /loopback address; give --allow-local/,
    )
  } finally {
    server.close()
  }
})

test('a still reads the web font, the Thai fallback, the shadowed card, the same each time', {
  skip,
}, async () => {
  const files: Record<string, [string, string]> = {
    '/style.html': [fixture('style.html'), 'text/html'],
    '/IBMPlexSans-Regular.ttf': [
      join(plugins, 'font-ibm-plex-sans', 'assets', 'fonts', 'IBMPlexSans-Regular.ttf'),
      'font/ttf',
    ],
  }
  const server = createServer((req, res) => {
    const file = files[req.url ?? '']
    if (!file) {
      res.writeHead(404)
      res.end()
      return
    }
    const body = readFileSync(file[0])
    res.writeHead(200, { 'content-type': file[1], 'content-length': body.length })
    res.end(body)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  try {
    const still = async (more: Partial<Options> = {}) => {
      const out = join(outs, `still-${n++}`)
      const r = await captureWeb({
        page: `http://127.0.0.1:${port}/style.html`,
        out,
        still: 500,
        rafHz: 60,
        viewport: { width: 800, height: 400 },
        allowLocal: true,
        ...more,
      })
      return { ...r, png: readFileSync(join(out, 'style.png')) }
    }
    const first = await still()
    const again = await still()
    const slow = await still({ cpuThrottle: 6 })
    assert.equal(undated(again.json), undated(first.json), 'a repeat gives the same bytes')
    assert.equal(undated(slow.json), undated(first.json), 'a 6x throttled still is the same')
    assert.ok(first.png.equals(again.png), 'and the same screenshot')

    const host = { io: { read: async (p: string) => new Uint8Array(readFileSync(p)) } } as Host
    const style = await loadStyle(host, first.path)
    assert.equal(style.params.root, ':root')
    assert.match(String(style.tool.chrome), /^(Chrome|HeadlessChrome)\//)
    assert.deepEqual(style.screenshot, {
      path: 'style.png',
      width: 800,
      height: 400,
      sha256: await sha256(new Uint8Array(first.png)),
    })
    const near = (got: number[], want: number[], what: string) =>
      assert.ok(
        got.length === want.length && got.every((v, i) => Math.abs(v - (want[i] as number)) <= 0.5),
        `${what} is ${got}, not within 0.5 px of ${want}`,
      )

    // The shadowed card, its pseudo-element bar, and the computed values as Chrome gives them.
    const card = styleOf(style, '[data-id="card"]')
    near(card.box, [40, 60, 320, 200], 'the card')
    assert.equal(card.dataId, 'card')
    assert.equal(card.styles['box-shadow'], 'rgba(0, 0, 0, 0.25) 0px 12px 32px 0px')
    assert.equal(card.styles['background-color'], 'rgb(255, 255, 255)')
    assert.equal(card.styles['border-top-left-radius'], '16px')
    assert.equal(card.styles['border-bottom-right-radius'], '8px')
    const after = styleOf(style, '[data-id="card"]', '::after')
    near(after.box, [40, 256, 320, 4], 'the card::after')
    assert.equal(after.styles['background-color'], 'rgb(220, 40, 40)')
    assert.ok(after.paintOrder > card.paintOrder, 'the bar is drawn over the card')
    const h1 = styleOf(style, '[data-id="card"] > h1:nth-child(1)')
    near(h1.box, [64, 84, 272, 48], 'the h1')
    assert.deepEqual(
      [
        h1.styles['font-family'],
        h1.styles['font-size'],
        h1.styles['line-height'],
        h1.styles['letter-spacing'],
        h1.styles['font-weight'],
        h1.styles.color,
      ],
      ['"Plex Test", sans-serif', '40px', '48px', '-0.5px', '400', 'rgb(20, 30, 40)'],
    )
    // A turned badge: its box as drawn, its transform and opacity as computed.
    const badge = styleOf(style, '#badge')
    const [c, s] = [Math.cos((8 * Math.PI) / 180), Math.sin((8 * Math.PI) / 180)]
    const [w, h] = [120 * c + 40 * s, 120 * s + 40 * c]
    near(badge.box, [480 - w / 2, 100 - h / 2, w, h], 'the badge')
    assert.equal(badge.styles.transform, 'matrix(0.990268, -0.139173, 0.139173, 0.990268, 0, 0)')
    assert.equal(badge.styles.opacity, '0.8')
    // The bar a CSS animation widens 200 px in 1 s is half way at 500 ms.
    near(styleOf(style, '#bar').box, [420, 220, 100, 10], 'the bar')
    // A canvas is pixels only, said so, and an input's text is the browser's own control's.
    assert.ok(style.limits.some((l) => l.where.endsWith('canvas:nth-child(3)')))
    assert.ok(style.limits.some((l) => l.where.endsWith('input:nth-child(7)')))
    // The edges, the underline and the clip are read.
    const framed = styleOf(style, '#framed')
    assert.deepEqual(
      [
        framed.styles['border-top-width'],
        framed.styles['border-left-style'],
        framed.styles['border-bottom-color'],
        framed.styles['outline-style'],
        framed.styles['outline-color'],
        framed.styles['outline-offset'],
        framed.styles['text-decoration-line'],
        framed.styles['clip-path'],
      ],
      [
        '3px',
        'dashed',
        'rgb(200, 0, 0)',
        'solid',
        'rgb(0, 0, 255)',
        '1px',
        'underline',
        'inset(2px)',
      ],
    )
    // White space between elements is not drawn: no run for it, and no limit.
    assert.ok(style.texts.every((t) => t.boxes.length > 0 && t.text.trim() !== ''))
    assert.ok(!style.limits.some((l) => l.reason.includes('no node to ask for fonts')))

    // The fonts each text node was drawn with: the web font, and a system font for the Thai.
    const [hello] = textsOf(style, '[data-id="card"] > h1:nth-child(1)')
    assert.equal(hello?.text, 'Hello')
    near(hello?.boxes[0]?.box.slice(0, 2) ?? [], [64, 82], 'the Hello line')
    assert.deepEqual(hello?.fonts, [
      {
        familyName: 'IBM Plex Sans',
        postScriptName: 'IBMPlexSans',
        isCustomFont: true,
        glyphCount: 5,
      },
    ])
    const [thai] = textsOf(style, '[data-id="card"] > p:nth-child(2)')
    assert.equal(thai?.text, 'สวัสดี Plex')
    const plex = thai?.fonts.filter((f) => f.isCustomFont) ?? []
    assert.deepEqual(
      plex,
      [
        {
          familyName: 'IBM Plex Sans',
          postScriptName: 'IBMPlexSans',
          isCustomFont: true,
          glyphCount: 5,
        },
      ],
      'the space and "Plex" are in the web font',
    )
    const fallback = thai?.fonts.filter((f) => !f.isCustomFont) ?? []
    assert.equal(fallback.length, 1, `one fallback: ${JSON.stringify(thai?.fonts)}`)
    assert.ok((fallback[0]?.glyphCount ?? 0) > 0)
    // macOS draws Thai in Thonburi, which shapes the six code points as four glyphs.
    if (fallback[0]?.familyName === 'Thonburi') assert.equal(fallback[0].glyphCount, 4)
    // The web fonts are named, their files not copied; one from a blob: URL is its origin only,
    // since the rest is new on each load.
    assert.deepEqual(
      style.fontFaces.map((f) => [f.fontFamily, f.platformFontFamily, f.src]),
      [
        ['Blob Plex', 'IBM Plex Sans', `blob:http://127.0.0.1:${port}`],
        ['Plex Test', 'IBM Plex Sans', `http://127.0.0.1:${port}/IBMPlexSans-Regular.ttf`],
      ],
    )
    assert.deepEqual(textsOf(style, '#blobbed')[0]?.fonts, [
      {
        familyName: 'IBM Plex Sans',
        postScriptName: 'IBMPlexSans',
        isCustomFont: true,
        glyphCount: 4,
      },
    ])
    assert.deepEqual(readdirSync(dirname(first.path)).sort(), ['style.json', 'style.png'])
    const ttf = await sha256(
      new Uint8Array(readFileSync(files['/IBMPlexSans-Regular.ttf']?.[0] as string)),
    )
    assert.ok(
      'responses' in style.source &&
        style.source.responses.some((r) => r.url.endsWith('.ttf') && r.sha256 === ttf),
      'the font is hashed as served',
    )

    // A root reads its subtree only.
    const card2 = await loadStyle(host, (await still({ root: '[data-id="card"]' })).path)
    assert.deepEqual(
      [...new Set(card2.elements.map((e) => e.element))],
      [
        '[data-id="card"]',
        '[data-id="card"] > h1:nth-child(1)',
        '[data-id="card"] > p:nth-child(2)',
      ],
    )
    await assert.rejects(still({ root: '#nothing' }), /--root "#nothing" matches nothing/)
  } finally {
    server.close()
  }
})

test('a motion capture records the fonts each tracked text fell back to, at the first frame', {
  skip,
}, async () => {
  const doc = JSON.parse(
    await capture({
      page: fixture('fonts.html'),
      track: ['#title', '#card', '#box', '#none'],
      duration: 0.2,
    }),
  ) as Doc
  const fonts = 'url' in doc.source ? doc.source.fonts : undefined
  // A child's text counts for the element; one with no text, or none matching, has no entry.
  assert.deepEqual(
    fonts?.map((f) => f.element),
    ['#title', '#card'],
  )
  const [title, card] = fonts ?? []
  // No machine has the family asked for: what drew it is a system font, named.
  for (const [entry, glyphs] of [
    [title, 5],
    [card, 6],
  ] as const) {
    assert.equal(entry?.fonts.length, 1, JSON.stringify(entry))
    const [font] = entry?.fonts ?? []
    assert.notEqual(font?.familyName, 'Shaderera Missing Face')
    assert.ok(font?.familyName && font.postScriptName)
    assert.equal(font?.isCustomFont, false)
    assert.equal(font?.glyphCount, glyphs)
  }
})

/** A server for test/web-capture/contexts/ on 127.0.0.1, which a page reaches as localhost too. */
const serveContexts = async () => {
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.webm': 'video/webm',
  }
  const server = createServer((req, res) => {
    const name = basename(new URL(req.url ?? '/', 'http://x').pathname)
    const file = join(fixture('contexts'), name)
    if (!existsSync(file)) {
      res.writeHead(404)
      res.end()
      return
    }
    const body = readFileSync(file)
    res.writeHead(200, {
      'content-type': types[extname(name)] ?? 'application/octet-stream',
      'content-length': body.length,
    })
    res.end(body)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return { url: (name: string) => `http://127.0.0.1:${port}/${name}`, close: () => server.close() }
}
/** A still of the page, its JSON and its screenshot. */
const still = async (page: string, more: Partial<Options> = {}) => {
  const out = join(outs, `still-${n++}`)
  const r = await captureWeb({
    page,
    out,
    still: 500,
    rafHz: 30,
    viewport: { width: 500, height: 320 },
    ...more,
  })
  return { ...r, png: readFileSync(join(out, 'style.png')) }
}
/** The same still again and at 6x CPU throttling: the same bytes, the same screenshot. */
const sameStill = async (page: string, more: Partial<Options> = {}) => {
  const first = await still(page, more)
  const again = await still(page, more)
  const slow = await still(page, { ...more, cpuThrottle: 6 })
  assert.equal(undated(again.json), undated(first.json), 'a repeat gives the same bytes')
  assert.equal(undated(slow.json), undated(first.json), 'a 6x throttled still is the same')
  assert.ok(again.png.equals(first.png), 'and the same screenshot')
  assert.ok(slow.png.equals(first.png), 'and the same screenshot at 6x throttling')
  return first
}
/** The red of the screenshot's pixel at (x, y), in CSS pixels at a pixel ratio of 1. */
const red = (png: Buffer, x: number, y: number) => {
  const img = decodePng(png)
  return img.data[(y * img.width + x) * img.channels] as number
}
const ms = (t: number) => t * 1000

test('a worker runs on the clock: its timers, frames, Date and replies, at any speed', {
  skip,
}, async () => {
  const server = await serveContexts()
  try {
    const started = performance.now()
    const json = await sameEveryTime(
      server.url('worker.html'),
      ['#timer', '#raf', '#date', '#reply', '#module'],
      { allowLocal: true },
    )
    // The worker that ends itself is let go at once, not waited for.
    assert.ok(performance.now() - started < 30000, 'no capture waits out a worker that ended')
    const doc = JSON.parse(json) as Doc
    assert.deepEqual(doc.limits, [])
    const each = (id: string, expected: (ms: number) => number) => {
      const samples = samplesOf(json, id, 'translateX')
      assert.equal(samples.length, 49)
      for (const [t, v] of samples) assert.equal(v, expected(ms(t)), `${id} at ${t} s`)
    }
    // Started with the page at 0 ms: a 50 ms interval, a 100 ms timeout chain in a module worker,
    // its animation frames on the page's ticks with Date at the clock date, and a reply to each of
    // the page's frames at the time it was sent.
    each('#timer', (t) => 50 * Math.floor(t / 50 + 1e-9))
    each('#module', (t) => 100 * Math.floor(t / 100 + 1e-9))
    each('#raf', Math.round)
    each('#date', Math.round)
    each('#reply', Math.round)
  } finally {
    server.close()
  }
})

test('frames run on the clock, of this origin or another, and added later', { skip }, async () => {
  const server = await serveContexts()
  try {
    const ids = ['same', 'cross', 'late', 'near'].flatMap((n) => [`#${n}`, `#${n}-born`])
    const json = await sameEveryTime(server.url('frames.html'), ids, { allowLocal: true })
    assert.deepEqual((JSON.parse(json) as Doc).limits, [])
    const each = (id: string, expected: (ms: number) => number) => {
      for (const [t, v] of samplesOf(json, id, 'translateX'))
        assert.equal(v, expected(ms(t)), `${id} at ${t} s`)
    }
    // Each frame's animation frames are the page's ticks; one added at 500 ms (on localhost) or
    // 700 ms (of this origin) starts then, and its first tick is the next one.
    for (const name of ['same', 'cross']) {
      each(`#${name}`, Math.round)
      each(`#${name}-born`, () => 0)
    }
    for (const [name, at] of [
      ['late', 500],
      ['near', 700],
    ] as const) {
      each(`#${name}`, (t) => (t > at + 1 ? Math.round(t) : 0))
      each(`#${name}-born`, (t) => (t > at + 1 ? at : 0))
    }
    // The frames' CSS spinners are drawn at the still's time: the same screenshot every time.
    await sameStill(server.url('frames.html'), { allowLocal: true })
  } finally {
    server.close()
  }
})

test("a frame of another site sees the page's locale", { skip }, async () => {
  const server = await serveContexts()
  try {
    const flags = async (locale?: string) => {
      const doc = JSON.parse(
        await capture({
          page: server.url('locale.html'),
          track: ['#page', '#frame'],
          duration: 0.3,
          allowLocal: true,
          ...(locale ? { locale } : {}),
        }),
      ) as Doc
      assert.deepEqual(doc.limits, [])
      const last = (el: string) =>
        doc.tracks.find((t) => t.element === el && t.channel === 'translateX')?.samples.at(-1)?.[1]
      return [last('#page'), last('#frame')]
    }
    assert.deepEqual(await flags(), [0, 0])
    assert.deepEqual(await flags('th-TH'), [3, 3], 'navigator.language and Intl in both')
  } finally {
    server.close()
  }
})

test('an OffscreenCanvas a worker draws shows the frame at its time', { skip }, async () => {
  const page = fixture('contexts/offscreen.html')
  const json = await sameEveryTime(page, ['#drawn'])
  for (const [t, v] of samplesOf(json, '#drawn', 'translateX'))
    assert.equal(v, Math.round(ms(t) / 10), `the grey posted at ${t} s`)
  const shot = await sameStill(page)
  assert.equal(red(shot.png, 20, 20), 50, 'the canvas shows the grey drawn at 500 ms')
})

test('a video shows the frame at its own time, and plays for the page', { skip }, async () => {
  const page = fixture('contexts/video.html')
  // Frame n of video.webm is luma 16 + 3n, so the screenshot names it.
  const frames = (png: Buffer) =>
    [32, 112, 192, 272, 352, 432].map((x) => Math.round((red(png, x, 32) * 219) / 765))
  const viewport = { width: 500, height: 100 }
  // At 500 ms: #auto at 0.5 s, #later played at 200 ms at 0.3 s, #never at its first frame, #fast
  // at twice the rate at 1 s, #seek seeked to 1 s at 300 ms at 1.2 s, #loud (autoplay with sound)
  // at 0.5 s.
  assert.deepEqual(frames((await sameStill(page, { viewport })).png), [15, 9, 0, 30, 36, 15])
  // At 2.5 s the loops have come round, and #later and #loud have ended on their last frame.
  assert.deepEqual(
    frames((await sameStill(page, { viewport, still: 2500 })).png),
    [15, 59, 0, 30, 36, 59],
  )
  // The page reads the rate it set and its own ratechange only, and only #never as paused.
  const json = await sameEveryTime(page, ['#probe'], { viewport, duration: 0.6 })
  assert.deepEqual((JSON.parse(json) as Doc).limits, [])
  for (const [t, v] of samplesOf(json, '#probe', 'translateX'))
    assert.equal(v, t >= 0.45 ? 201 : 0, `#probe at ${t} s`)
  for (const [t, v] of samplesOf(json, '#probe', 'translateY'))
    assert.equal(v, t >= 0.45 ? 1 : 0, `#probe at ${t} s`)
})

test('what the clock cannot hold is a limit, named in the file and on the command line', {
  skip,
}, async () => {
  const server = await serveContexts()
  try {
    const out = join(outs, 'limits')
    // Run apart, so this process goes on serving the page.
    const cli = await promisify(execFile)(process.execPath, [
      join(project, 'tools', 'capture-web.ts'),
      server.url('limits.html'),
      ...['--out', out, '--track', '#box', '--fps', '10', '--rafHz', '10', '--duration', '0.3'],
      ...['--viewport', '200x100', '--allow-local'],
    ])
    const doc = JSON.parse(readFileSync(join(out, 'tracks.json'), 'utf8')) as Doc
    const port =
      'a MessagePort was sent to it: messages on that port are not waited for, so a reply on it can land on a later frame'
    const expected = [
      [server.url('shared.js'), 'a shared worker: its clock is not held, so it runs on real time'],
      [server.url('port.js'), port],
      [
        'BroadcastChannel motion',
        'its messages between frames and workers are not waited for, so one can land on a later frame',
      ],
      [server.url('port.html'), port],
      [
        server.url('sibling.html'),
        'it messaged a frame that is not its parent or child: those messages are not waited for, so one can land on a later frame',
      ],
    ]
    for (const [where, reason] of expected) {
      assert.ok(
        doc.limits.some((l) => l.where === where && l.reason === reason && l.from === 0),
        `${where} is a limit`,
      )
      assert.ok(cli.stderr.includes(`limit: ${where}: ${reason}`), `and the CLI names ${where}`)
    }
    assert.equal(doc.limits.length, expected.length, JSON.stringify(doc.limits))
  } finally {
    server.close()
  }
})

test('a held video that cannot play is a limit', { skip }, async () => {
  const server = await serveContexts()
  try {
    const json = await capture({
      page: server.url('unplayable.html'),
      track: ['video'],
      duration: 0.3,
      allowLocal: true,
    })
    assert.deepEqual(
      (JSON.parse(json) as Doc).limits.map((l) => [l.where, l.reason]),
      [
        [
          server.url('unplayable.html'),
          'a video that could not be played (MediaError code 4): its play() resolved, so a fallback a visitor sees may be missing',
        ],
      ],
    )
  } finally {
    server.close()
  }
})

test('a video its server cannot seek is a limit, and frames do not wait on it', {
  skip,
}, async () => {
  // The test's server does not serve ranges, so Chrome can seek the video only to 0.
  const server = await serveContexts()
  try {
    const started = performance.now()
    const json = await capture({
      page: server.url('unseekable.html'),
      track: ['video'],
      duration: 1,
      fps: 10,
      allowLocal: true,
    })
    assert.ok(performance.now() - started < 30000, 'no frame waits out the settle time')
    assert.deepEqual(
      (JSON.parse(json) as Doc).limits.map((l) => [l.where, l.reason]),
      [
        [
          server.url('video.webm'),
          'a video that cannot be seeked to its time (its server may not serve ranges): it shows the frame it has',
        ],
      ],
    )
  } finally {
    server.close()
  }
})

test('a still after a scroll has its boxes from the viewport and the scroll recorded', {
  skip,
}, async () => {
  const { path } = await captureWeb({
    page: fixture('scroll.html'),
    out: join(outs, `still-${n++}`),
    still: 500,
    rafHz: 60,
    viewport: { width: 800, height: 400 },
    trigger: 'scroll',
    at: 0,
    scrollTo: 600,
    scrollMs: 0,
  })
  const host = { io: { read: async (p: string) => new Uint8Array(readFileSync(p)) } } as Host
  const style = await loadStyle(host, path)
  assert.deepEqual(style.scroll, { x: 0, y: 600 })
  // #inline is at 100 on the page, so 600 px of scroll puts it at -500 in the viewport.
  assert.deepEqual(styleOf(style, '#inline').box, [200, -500, 40, 40])
  // #sticky is position: fixed, so its box stays where the viewport has it.
  assert.deepEqual(styleOf(style, '#sticky').box, [20, 140, 40, 40])
})

test.after(() => rmSync(outs, { recursive: true, force: true }))
