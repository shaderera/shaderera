// Captures a web page's motion as reference tracks (shaderera.analysis/1, kind reference-tracks,
// written by analysis-reference-tracks' writer), so a film can copy it one to one. It runs in the
// person's own Chrome, in new headless with a throwaway profile, with a clock injected before any
// page script (tools/inpage/clock.js): the page moves only when the capture advances it, so frame
// k is the page at k / fps however slow the machine is.
//
//   node tools/capture-web.ts <url|file> --out <dir> --track <selector> [--track <selector>…]
//     --fps <n> --duration <s> --viewport <width>x<height>
//     [--rafHz <n>] [--seed <n>] [--dpr <n>] [--media <name>=<value>…] [--allow-local]
//     [--cpu-throttle <n>] [--time-origin <ms>] [--clock-date <ISO 8601>] [--timezone <IANA>]
//     [--locale <BCP 47>]
//     [--settle load|loaded] [--trigger load|none|click|hover|leave|scroll --target <selector>
//     --at <ms> [--scroll-to <px> --scroll-ms <ms>]]
//   node tools/capture-web.ts <url|file> --out <dir> --still <ms> --rafHz <n>
//     --viewport <width>x<height> [--root <selector>] [--style <property>…] [the same others]
//
// Writes <dir>/tracks.json. Each frame, in this order: an input due by its time is dispatched
// over CDP at its own time (the clock advanced to it, then synced once the browser delivered it),
// animations are synced, the clock advances to the frame's time, running timers and animation
// frames in time order, the capture waits for the network and the page's pending work, then every
// tracked element's box, transform and opacity, and the window's scroll, are read. The README
// lists the channels and the limits.
//
// With --still, the clock runs the same way to that one moment, and <dir>/style.json (kind
// reference-style, tools/web-capture-style.ts) and <dir>/style.png are written instead.

import { sha256 } from '@shaderera/core'
import type { Limit, Sample, Track } from '../src/reference/tracks.ts'
import { styleJson } from './reference-style.ts'
import { tracksJson } from './reference-tracks.ts'
import { checkHost, type Refused, startProxy } from './web-capture-net.ts'
import { pngSize, readStyle, STYLES } from './web-capture-style.ts'

/** This tool's version, recorded in every capture. */
export const VERSION = '0.3.0'

/** Chrome from CHROME (docs/determinism.md), else the first of a few usual install paths. */
export const chromePath = async () => {
  const { existsSync } = await import('node:fs')
  return (
    process.env.CHROME ??
    [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      '/usr/bin/google-chrome',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ].find((p) => existsSync(p))
  )
}

/** What a capture is asked for. Everything that changes the samples is here and recorded. */
export type CaptureOptions = {
  /** A URL (http, https, file) or a path to an HTML file. */
  page: string
  /** The folder tracks.json (or style.json and style.png) is written to. */
  out: string
  /** CSS selectors, one element each: the first match in document order. Not with `still`. */
  track?: string[]
  /** Frames per second. Not with `still`. */
  fps?: number
  /** Seconds captured from the load; frames at 0, 1/fps, … up to it. Not with `still`. */
  duration?: number
  viewport: { width: number; height: number }
  /**
   * Animation frames per second the page sees; a whole multiple of fps, fps when left out. A
   * still needs it, and the still's time must be on one of its frames.
   */
  rafHz?: number
  /** The page's time to read its style facts at, in ms after the freeze, instead of motion. */
  still?: number
  /** For a still: the element whose subtree is read, the first match. `:root` when left out. */
  root?: string
  /** For a still: computed styles read beside STYLES, as CSS names them. */
  styles?: string[]
  /** Math.random's seed in the page. */
  seed?: number
  /** What performance.now, rAF timestamps and document.timeline read at the freeze, in ms. */
  timeOrigin?: number
  /** What Date reads at the freeze, as ISO 8601. */
  clockDate?: string
  /** The time zone the page's Date and Intl see, an IANA name. */
  timezone?: string
  /** The locale the page's Intl, navigator.language and Accept-Language see, a BCP 47 tag. */
  locale?: string
  /** Device pixels per CSS pixel. */
  devicePixelRatio?: number
  /** Media features the page sees, over MEDIA. */
  media?: Record<string, string>
  /** Let loopback, private and link-local addresses through; cloud metadata stays refused. */
  allowLocal?: boolean
  /** Chrome's CPU throttling rate, to check that a capture does not depend on speed. */
  cpuThrottle?: number
  /**
   * When the clock freezes: `load` (the default) at the first script, `loaded` at the load event,
   * the page running on real time until then.
   */
  settle?: Settle
  /** What starts the motion: `load` (the default), `none`, or an input sent at `at`. */
  trigger?: Trigger
  /** The element the input goes to, at the centre of its box: for click, hover, leave, scroll. */
  target?: string
  /** When the input is sent, in ms of the page's time after the freeze. */
  at?: number
  /** For a scroll: the window's scrollY the wheel aims for, in CSS pixels. */
  scrollTo?: number
  /** For a scroll: how long the wheel takes, in ms; 0 is one wheel event. */
  scrollMs?: number
  /** Progress lines. */
  log?: (line: string) => void
}

/** The media features a capture sets unless asked otherwise, so the OS's settings do not leak in. */
export const MEDIA: Record<string, string> = {
  'prefers-color-scheme': 'light',
  'prefers-reduced-motion': 'no-preference',
}

/** What the page's clocks read at the freeze unless asked otherwise: constants, never today. */
export const CLOCK = { timeOrigin: 0, clockDate: '2000-01-01T00:00:00.000Z', timezone: 'UTC' }

/** When the clock freezes. */
export const SETTLES = ['load', 'loaded'] as const
export type Settle = (typeof SETTLES)[number]

/** What starts the motion: the load, nothing, or an input sent over CDP. */
export const TRIGGERS = ['load', 'none', 'click', 'hover', 'leave', 'scroll'] as const
export type Trigger = (typeof TRIGGERS)[number]

/** The element name the window's own channels are under; no --track may take it. */
export const WINDOW = 'window'

/** The window's channels, read each frame whatever the trigger, and their unit. */
export const WINDOW_CHANNELS: [channel: string, unit: string][] = [
  ['scrollX', 'css-px'],
  ['scrollY', 'css-px'],
]

/** The locale a capture sets unless asked otherwise: a constant, so the machine's does not leak in. */
export const LOCALE = 'en-US'

/** Each channel read per element, and its unit. */
export const CHANNELS: [channel: string, unit: string][] = [
  ['x', 'css-px'],
  ['y', 'css-px'],
  ['width', 'css-px'],
  ['height', 'css-px'],
  ['opacity', 'ratio'],
  ['translateX', 'css-px'],
  ['translateY', 'css-px'],
  ['rotate', 'deg'],
  ['skewX', 'deg'],
  ['scaleX', 'ratio'],
  ['scaleY', 'ratio'],
  ['originX', 'css-px'],
  ['originY', 'css-px'],
]

const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0

/** The options checked and filled, or a refusal naming what is wrong. Nothing starts before it. */
export const checkOptions = (o: CaptureOptions) => {
  if (!o.page) throw new Error('give the page to capture: a URL or an HTML file')
  if (!o.out)
    throw new Error('give --out <dir>, the folder tracks.json (or style.json) is written to')
  const { width, height } = o.viewport
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error(`--viewport ${width}x${height} is not whole CSS pixels, like 1280x720`)
  const mode = o.still === undefined ? motionOf(o) : stillOf(o)
  const seed = o.seed ?? 1
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new Error(`--seed ${seed} is not a whole number from 0 to 4294967295`)
  const devicePixelRatio = o.devicePixelRatio ?? 1
  if (!positive(devicePixelRatio)) throw new Error(`--dpr ${devicePixelRatio} is not above 0`)
  const throttle = o.cpuThrottle ?? 1
  if (!(Number.isFinite(throttle) && throttle >= 1))
    throw new Error(`--cpu-throttle ${throttle} is not a rate of 1 or more`)
  const timeOrigin = o.timeOrigin ?? CLOCK.timeOrigin
  if (!Number.isInteger(timeOrigin) || timeOrigin < 0)
    throw new Error(`--time-origin ${timeOrigin} is not whole milliseconds of 0 or more`)
  const given = o.clockDate ?? CLOCK.clockDate
  const epoch = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?(Z|[+-]\d\d:\d\d)$/.test(given)
    ? Date.parse(given)
    : Number.NaN
  if (!Number.isFinite(epoch))
    throw new Error(
      `--clock-date ${given} is not an ISO 8601 date and time with its offset, like ${CLOCK.clockDate}`,
    )
  const timezone = o.timezone ?? CLOCK.timezone
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone })
  } catch {
    throw new Error(`--timezone ${timezone} is not an IANA time zone, like UTC or Asia/Bangkok`)
  }
  const settle = o.settle ?? 'load'
  if (!SETTLES.includes(settle))
    throw new Error(`--settle ${settle} is not one of ${SETTLES.join(', ')}`)
  let locale: string
  try {
    locale = Intl.getCanonicalLocales(o.locale ?? LOCALE)[0] as string
  } catch {
    throw new Error(`--locale ${o.locale} is not a BCP 47 language tag, like en-US or th-TH`)
  }
  const last = mode.times.at(-1) as number
  const trigger = checkTrigger(
    o,
    last,
    o.still === undefined
      ? `the last frame, at ${+last.toFixed(3)} ms`
      : `the still, at ${last} ms`,
  )
  return {
    ...o,
    ...mode,
    seed,
    timeOrigin,
    clockDate: new Date(epoch).toISOString(),
    epoch,
    timezone,
    locale,
    devicePixelRatio,
    cpuThrottle: throttle,
    media: { ...MEDIA, ...o.media },
    allowLocal: o.allowLocal ?? false,
    settle,
    trigger,
  }
}

/** A motion capture's settings checked: the tracks, the fps, the duration and its frames. */
const motionOf = (o: CaptureOptions) => {
  for (const [given, flag] of [
    [o.root, '--root'],
    [o.styles, '--style'],
  ] as const)
    if (given !== undefined)
      throw new Error(`${flag} is for --still: a motion capture reads only the --track elements`)
  const track = o.track ?? []
  if (track.length === 0)
    throw new Error(
      'give at least one --track <selector>, the element whose motion to capture, or --still <ms> for the style facts at one moment',
    )
  if (new Set(track).size !== track.length)
    throw new Error(`--track names an element twice: ${track.join(', ')}`)
  if (track.includes(WINDOW))
    throw new Error(
      `--track ${WINDOW}: that name holds the window's own scrollX and scrollY, which every capture records`,
    )
  const fps = o.fps as number
  if (!positive(fps)) throw new Error(`--fps ${fps} is not a rate above 0`)
  const duration = o.duration as number
  if (!positive(duration)) throw new Error(`--duration ${duration} is not seconds above 0`)
  const rafHz = o.rafHz ?? fps
  if (!positive(rafHz)) throw new Error(`--rafHz ${rafHz} is not a rate above 0`)
  const ratio = rafHz / fps
  if (ratio < 1 - 1e-9 || Math.abs(ratio - Math.round(ratio)) > 1e-9)
    throw new Error(
      `--rafHz ${rafHz} is not a whole multiple of --fps ${fps}: a JS animation would show a tick from before the frame while CSS shows the frame itself. Give ${[1, 2, 3].map((m) => m * fps).join(', ')}…`,
    )
  const frames = Math.floor(duration * fps + 1e-9) + 1
  return {
    mode: 'motion' as const,
    track,
    fps,
    duration,
    rafHz,
    frames,
    times: Array.from({ length: frames }, (_, k) => frameMs(k, fps)),
    root: undefined,
    styles: undefined,
  }
}

/** A still's settings checked: its time on an animation frame, the root and the styles. */
const stillOf = (o: CaptureOptions) => {
  for (const [given, flag] of [
    [o.track, '--track'],
    [o.fps, '--fps'],
    [o.duration, '--duration'],
  ] as const)
    if (given !== undefined)
      throw new Error(
        `${flag} is for motion: --still reads every element under --root at one moment`,
      )
  const still = o.still as number
  if (!(Number.isFinite(still) && still >= 0))
    throw new Error(`--still ${still} is not ms of 0 or more`)
  const rafHz = o.rafHz
  if (rafHz === undefined)
    throw new Error(
      "--still needs --rafHz <n>, how often the page's requestAnimationFrame runs: it changes where a JS animation is at the still",
    )
  if (!positive(rafHz)) throw new Error(`--rafHz ${rafHz} is not a rate above 0`)
  // On an animation frame, a JS animation shows the still itself, as CSS does. The clock runs a
  // tick due within EPSILON_MS of its target, so that is how near a frame the still must be.
  const ticks = (still * rafHz) / 1000
  const frameAt = (k: number) => (k * 1000) / rafHz
  if (Math.abs(still - frameAt(Math.round(ticks))) > EPSILON_MS) {
    const before = Math.floor(ticks)
    throw new Error(
      `--still ${still} is not on an animation frame at --rafHz ${rafHz} (one each ${+frameAt(1).toFixed(3)} ms): a JS animation would show a tick from before it while CSS shows the moment itself. Give ${frameAt(before)} or ${frameAt(before + 1)}, or a --rafHz that makes ${still} ms a whole number of frames`,
    )
  }
  const root = o.root ?? ':root'
  if (root.trim() === '') throw new Error('--root is empty: give a CSS selector')
  const added = o.styles ?? []
  for (const [i, s] of added.entries()) {
    if (s.startsWith('--'))
      throw new Error(
        `--style ${s} is a custom property, which DOMSnapshot does not read: the standard properties it feeds are read with their computed values`,
      )
    if (!/^-?[a-z][a-z0-9-]*$/.test(s))
      throw new Error(`--style ${JSON.stringify(s)} is not a CSS property name, like white-space`)
    if (STYLES.includes(s))
      throw new Error(`--style ${s} is read already: it is in the default list`)
    if (added.indexOf(s) !== i) throw new Error(`--style ${s} is given twice`)
  }
  return {
    mode: 'still' as const,
    still,
    rafHz,
    root,
    styles: [...STYLES, ...added],
    times: [still],
    track: [] as string[],
    fps: undefined,
    duration: undefined,
    frames: 1,
  }
}

/** The trigger as recorded in params: its type and only the settings it takes. */
export type TriggerParams = {
  type: Trigger
  target?: string
  at?: number
  scrollTo?: number
  scrollMs?: number
}

/** The trigger's settings checked: each input takes its own and refuses the others. */
const checkTrigger = (o: CaptureOptions, lastMs: number, last: string): TriggerParams => {
  const type = o.trigger ?? 'load'
  if (!TRIGGERS.includes(type))
    throw new Error(`--trigger ${type} is not one of ${TRIGGERS.join(', ')}`)
  const given = {
    target: o.target,
    at: o.at,
    scrollTo: o.scrollTo,
    scrollMs: o.scrollMs,
  }
  const flag = { target: '--target', at: '--at', scrollTo: '--scroll-to', scrollMs: '--scroll-ms' }
  const takes: Record<Trigger, (keyof typeof given)[]> = {
    load: [],
    none: [],
    click: ['target', 'at'],
    hover: ['target', 'at'],
    leave: ['target', 'at'],
    scroll: ['target', 'at', 'scrollTo', 'scrollMs'],
  }
  for (const k of Object.keys(given) as (keyof typeof given)[])
    if (given[k] !== undefined && !takes[type].includes(k))
      throw new Error(
        `${flag[k]} is not for --trigger ${type}: ${
          takes[type].length > 0
            ? `it takes ${takes[type].map((t) => flag[t]).join(', ')}`
            : 'it sends no input'
        }`,
      )
  if (type === 'load' || type === 'none') return { type }
  // The target is where the pointer goes; a scroll without one wheels at the viewport's centre.
  if (type !== 'scroll' && !o.target)
    throw new Error(`--trigger ${type} needs --target <selector>, the element the pointer goes to`)
  if (o.target !== undefined && o.target.trim() === '')
    throw new Error('--target is empty: give a CSS selector')
  const at = o.at
  if (at === undefined)
    throw new Error(
      `--trigger ${type} needs --at <ms>, when the input is sent: it moves the motion`,
    )
  // An input after the last frame would show on no frame, so it is refused, not dropped.
  if (!(Number.isFinite(at) && at >= 0 && at <= lastMs + EPSILON_MS))
    throw new Error(`--at ${at} is not ms from 0 to ${last}`)
  if (type === 'leave' && at === 0)
    throw new Error(
      '--at 0 with --trigger leave: the pointer is over the target from 0 ms, so it would leave as it arrives',
    )
  const out: TriggerParams = { type, at }
  if (o.target !== undefined) out.target = o.target
  if (type !== 'scroll') return out
  const { scrollTo, scrollMs } = o
  if (scrollTo === undefined || scrollMs === undefined)
    throw new Error(
      '--trigger scroll needs --scroll-to <px>, the scrollY the wheel aims for, and --scroll-ms <ms>, how long it takes (0 for one wheel event)',
    )
  if (!(Number.isInteger(scrollTo) && scrollTo >= 0))
    throw new Error(`--scroll-to ${scrollTo} is not whole CSS pixels of 0 or more`)
  if (!(Number.isFinite(scrollMs) && scrollMs >= 0))
    throw new Error(`--scroll-ms ${scrollMs} is not ms of 0 or more`)
  if (at + scrollMs > lastMs + EPSILON_MS)
    throw new Error(
      `--at ${at} and --scroll-ms ${scrollMs} end the scroll at ${at + scrollMs} ms, after ${last}`,
    )
  return { ...out, scrollTo, scrollMs }
}

/** One input the capture sends, at `ms` after the freeze. */
export type Input =
  | { ms: number; kind: 'hover' }
  | { ms: number; kind: 'click' }
  | { ms: number; kind: 'leave' }
  | { ms: number; kind: 'scroll-start' }
  | { ms: number; kind: 'wheel'; step: number; of: number }

/**
 * The inputs a trigger sends, in time order. A leave has the pointer over the target from 0 ms.
 * A scroll notes the scrollY at `at`, then sends one wheel event each 1/rafHz second up to
 * `at + scrollMs` (one at `at` when it is 0), the wheel's position a straight line in time.
 */
export const inputsOf = (trigger: TriggerParams, rafHz: number): Input[] => {
  const at = trigger.at ?? 0
  switch (trigger.type) {
    case 'load':
    case 'none':
      return []
    case 'click':
      return [{ ms: at, kind: 'click' }]
    case 'hover':
      return [{ ms: at, kind: 'hover' }]
    case 'leave':
      return [
        { ms: 0, kind: 'hover' },
        { ms: at, kind: 'leave' },
      ]
    case 'scroll': {
      const span = trigger.scrollMs ?? 0
      const of = Math.max(1, Math.ceil((span * rafHz) / 1000 - 1e-9))
      const wheels: Input[] = Array.from({ length: of }, (_, i) => ({
        ms: at + (span * (i + 1)) / of,
        kind: 'wheel' as const,
        step: i + 1,
        of,
      }))
      return [{ ms: at, kind: 'scroll-start' }, ...wheels]
    }
  }
}

/** How far apart two times may be and still be one: float rounding, never a real gap. */
const EPSILON_MS = 1e-6

/** Frame k's time in ms after the freeze. */
export const frameMs = (k: number, fps: number) => k * (1000 / fps)

/**
 * The inputs sent before each frame is read: each input with the first frame not before it, and
 * the time it is sent. That is its own time, or the frame's when float rounding puts it a hair
 * after (a wheel at 208.33333333333334 ms, a frame at 208.33333333333331), so the clock never has
 * to go back. Every input has a frame: the options refuse one after the last.
 */
export const batchesOf = (inputs: Input[], frames: number, fps: number) =>
  batchesAt(
    inputs,
    Array.from({ length: frames }, (_, k) => frameMs(k, fps)),
  )

/** The same for reads at any increasing times in ms: a still's one, or each frame's. */
export const batchesAt = (inputs: Input[], times: number[]) => {
  const batches: { input: Input; ms: number }[][] = times.map(() => [])
  let next = 0
  for (const [k, ms] of times.entries())
    for (let i = inputs[next]; i && i.ms <= ms + EPSILON_MS; i = inputs[++next])
      batches[k]?.push({ input: i, ms: Math.min(i.ms, ms) })
  if (next < inputs.length)
    throw new Error(`an input at ${inputs[next]?.ms} ms is after the last frame`)
  return batches
}

/**
 * Wheel event `step` of `of`'s delta for a scroll of `distance` CSS pixels: whole pixels (Chrome
 * scrolls a window by whole pixels), on a straight line, adding up to the distance exactly.
 */
export const wheelDelta = (distance: number, step: number, of: number) =>
  Math.round((distance * step) / of) - Math.round((distance * (step - 1)) / of)

/** The page's URL: a URL as given, a path to a file as its file: URL. */
export const pageUrl = async (page: string) => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(page) && !/^[a-z]:[\\/]/i.test(page)) {
    const url = new URL(page)
    if (!['http:', 'https:', 'file:'].includes(url.protocol))
      throw new Error(`${page}: capture takes an http, https or file URL, or a path to a file`)
    return url.href
  }
  const { existsSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  if (!existsSync(page)) throw new Error(`${page} is neither a URL nor a file`)
  return pathToFileURL(resolve(page)).href
}

/**
 * A 2D matrix (CSS `matrix(a, b, c, d, e, f)`) as `translate(tx, ty) rotate(r) skewX(k)
 * scale(sx, sy)`, which gives the same matrix back. Degrees for rotate and skew; scaleX is never
 * negative, so a mirror shows as a negative scaleY and a half turn.
 */
export const decompose = ([a, b, c, d, e, f]: number[]) => {
  const A = a as number
  const B = b as number
  const C = c as number
  const D = d as number
  const scaleX = Math.hypot(A, B)
  const theta = scaleX === 0 ? 0 : Math.atan2(B, A)
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  // The second column, turned back: (tan(skew) * scaleY, scaleY).
  const p = cos * C + sin * D
  const scaleY = -sin * C + cos * D
  const skew = scaleY === 0 ? 0 : Math.atan(p / scaleY)
  const deg = 180 / Math.PI
  return {
    translateX: e as number,
    translateY: f as number,
    rotate: theta * deg,
    skewX: skew * deg,
    scaleX,
    scaleY,
  }
}

/** An angle moved by whole turns to the one nearest `before`, so a turn past 180° keeps counting. */
export const unwrap = (angle: number, before: number | null) =>
  before === null ? angle : angle - 360 * Math.round((angle - before) / 360)

// Run in the page each frame: for each selector, null when nothing matches, else the first
// match's box, opacity, transform (the translate, rotate and scale properties, then transform,
// composed as CSS composes them) and transform origin. Percentages in `translate` are of the
// border box before transforms, unrounded, for an HTML element; an SVG element's are left unread,
// since their box depends on transform-box. Then the window's scroll, and each animation not
// declared yet on any element, with the time the clock first saw it.
const READ = `(sels) => {
  const c = self.__shadereraClock
  const seen = (self.__shadereraSeen ??= new WeakSet())
  const px = (v, ref) => v.endsWith('%') ? (parseFloat(v) * ref) / 100 : v.endsWith('px') ? parseFloat(v) : NaN
  const out = []
  const animations = []
  for (const sel of sels) {
    const all = document.querySelectorAll(sel)
    const el = all[0]
    if (!el) { out.push(null); continue }
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const unread = []
    let m = new DOMMatrix()
    // The border box from the used width and height, which offsetWidth rounds.
    let w = NaN
    let h = NaN
    if (el instanceof HTMLElement && cs.width.endsWith('px') && cs.height.endsWith('px')) {
      const n = (v) => parseFloat(v) || 0
      w = parseFloat(cs.width)
      h = parseFloat(cs.height)
      if (cs.boxSizing !== 'border-box') {
        w += n(cs.paddingLeft) + n(cs.paddingRight) + n(cs.borderLeftWidth) + n(cs.borderRightWidth)
        h += n(cs.paddingTop) + n(cs.paddingBottom) + n(cs.borderTopWidth) + n(cs.borderBottomWidth)
      }
    }
    if (cs.translate && cs.translate !== 'none') {
      const [x = '0px', y = '0px', z = '0px'] = cs.translate.split(' ')
      const t = [px(x, w), px(y, h), px(z, 0)]
      if (t.some(Number.isNaN)) unread.push('translate ' + cs.translate)
      else m = m.translate(t[0], t[1], t[2])
    }
    if (cs.rotate && cs.rotate !== 'none') {
      const p = cs.rotate.split(' ')
      const axis = { x: '1, 0, 0', y: '0, 1, 0', z: '0, 0, 1' }
      try {
        const angle = p[p.length - 1]
        const f = p.length === 1 ? 'rotate(' + angle + ')' : 'rotate3d(' + (p.length === 2 ? axis[p[0]] : p.slice(0, 3).join(', ')) + ', ' + angle + ')'
        m = m.multiply(new DOMMatrix(f))
      } catch { unread.push('rotate ' + cs.rotate) }
    }
    if (cs.scale && cs.scale !== 'none') {
      const s = cs.scale.split(' ').map((v) => v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v))
      if (s.some(Number.isNaN)) unread.push('scale ' + cs.scale)
      else m = m.scale(s[0], s[1] ?? s[0], s[2] ?? 1)
    }
    if (cs.transform && cs.transform !== 'none') {
      try { m = m.multiply(new DOMMatrix(cs.transform)) } catch { unread.push('transform ' + cs.transform) }
    }
    if (cs.offsetPath && cs.offsetPath !== 'none') unread.push('offset-path ' + cs.offsetPath)
    const [ox = '0px', oy = '0px'] = cs.transformOrigin.split(' ')
    out.push({
      matches: all.length,
      box: [r.x, r.y, r.width, r.height],
      opacity: parseFloat(cs.opacity),
      matrix: [m.a, m.b, m.c, m.d, m.e, m.f],
      is3d: !m.is2D,
      origin: [px(ox, w), px(oy, h)],
      unread,
    })
  }
  // A target's name: the --track selector it is the first match of, else a path from the root.
  const tracked = new Map()
  sels.forEach((sel) => { const el = document.querySelector(sel); if (el && !tracked.has(el)) tracked.set(el, sel) })
  const name = (el) => {
    if (!el) return null
    if (tracked.has(el)) return tracked.get(el)
    if (!el.isConnected || el.getRootNode() !== document) return null
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id)
    const path = []
    for (let e = el; e; e = e.parentElement) {
      const tag = e.localName
      const p = e.parentElement
      path.unshift(p && p.children.length > 1 ? tag + ':nth-child(' + ([...p.children].indexOf(e) + 1) + ')' : tag)
    }
    return path.join(' > ')
  }
  // Every animation the clock saw, in the order it saw them, then any it does not hold (scroll
  // and view timelines), each once: as the page wrote it, from getTiming() and getKeyframes().
  for (const a of [...c.drain(), ...document.getAnimations()]) {
    if (seen.has(a)) continue
    seen.add(a)
    const e = a.effect
    const target = e && e.target
    const timing = e ? { ...e.getTiming() } : {}
    // JSON has no Infinity; CSS writes it as this keyword.
    if (timing.iterations === Infinity) timing.iterations = 'infinite'
    const type = typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation ? 'css-animation'
      : typeof CSSTransition !== 'undefined' && a instanceof CSSTransition ? 'css-transition' : 'web-animation'
    const named = name(target)
    const entry = { element: named ?? (target ? target.localName : '(no target)'), type }
    if (target && named === null) entry.inDocument = false
    if (e && e.pseudoElement) entry.pseudoElement = e.pseudoElement
    if (type === 'css-animation') entry.name = a.animationName
    if (type === 'css-transition') entry.property = a.transitionProperty
    if (a.id) entry.id = a.id
    const start = c.startOf(a)
    if (start !== null) entry.start = start / 1000
    const tl = a.timeline
    if (tl !== document.timeline) {
      const kind = tl === null ? 'none' : typeof ViewTimeline !== 'undefined' && tl instanceof ViewTimeline ? 'view'
        : typeof ScrollTimeline !== 'undefined' && tl instanceof ScrollTimeline ? 'scroll' : 'other'
      entry.timeline = { type: kind }
      if (kind === 'scroll') entry.timeline.source = tl.source === document.scrollingElement ? 'window' : name(tl.source)
      if (kind === 'view') entry.timeline.subject = name(tl.subject)
      if (kind === 'scroll' || kind === 'view') entry.timeline.axis = tl.axis
    }
    entry.playbackRate = a.playbackRate
    entry.timing = timing
    if (e) entry.composite = e.composite
    entry.keyframes = e && e.getKeyframes ? e.getKeyframes() : []
    animations.push(entry)
  }
  return { elements: out, scroll: [scrollX, scrollY], animations }
}`

// Run in the page before an input: the centre of the target's box (the viewport's centre with
// no target), whether it has a box and is in the viewport, and the element the pointer is then
// over.
const POINT = `(sel) => {
  const describe = (e) => e ? e.localName + (e.id ? '#' + e.id : '') : 'nothing'
  if (sel === null) {
    const x = innerWidth / 2, y = innerHeight / 2
    return { x, y, boxed: true, inView: true, over: true, hit: describe(document.elementFromPoint(x, y)) }
  }
  const el = document.querySelector(sel)
  if (!el) return null
  const r = el.getBoundingClientRect()
  const x = r.x + r.width / 2, y = r.y + r.height / 2
  const hit = document.elementFromPoint(x, y)
  return {
    x, y,
    boxed: el.getClientRects().length > 0 && (r.width > 0 || r.height > 0),
    inView: x >= 0 && y >= 0 && x < innerWidth && y < innerHeight,
    over: !!hit && (hit === el || el.contains(hit)),
    hit: describe(hit),
  }
}`

/** A message the page or Chrome sent back that is an error. */
type CdpError = { code: number; message: string; data?: string }

/** A minimal DevTools protocol client over Node's WebSocket: flat sessions, one socket. */
const cdp = async (url: string) => {
  const ws = new WebSocket(url)
  await new Promise<void>((done, fail) => {
    ws.addEventListener('open', () => done(), { once: true })
    ws.addEventListener('error', () => fail(new Error(`could not reach Chrome at ${url}`)), {
      once: true,
    })
  })
  let id = 0
  const pending = new Map<
    number,
    { method: string; done: (v: unknown) => void; fail: (e: Error) => void }
  >()
  const listeners = new Map<string, ((params: never, session?: string) => void)[]>()
  let closed: Error | undefined
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(String(m.data)) as {
      id?: number
      result?: unknown
      error?: CdpError
      method?: string
      params?: unknown
      sessionId?: string
    }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.fail(new Error(`${p.method}: ${msg.error.message}`))
      else p.done(msg.result)
    } else if (msg.method)
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params as never, msg.sessionId)
  })
  ws.addEventListener('close', () => {
    closed = new Error('Chrome closed the DevTools connection')
    for (const p of pending.values()) p.fail(closed)
    pending.clear()
  })
  return {
    send: <T = Record<string, unknown>>(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string,
    ) =>
      new Promise<T>((done, fail) => {
        if (closed) return fail(closed)
        const n = ++id
        pending.set(n, { method, done: done as (v: unknown) => void, fail })
        ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }))
      }),
    on: <P>(method: string, fn: (params: P, session?: string) => void) => {
      listeners.set(method, [
        ...(listeners.get(method) ?? []),
        fn as (p: never, s?: string) => void,
      ])
    },
    close: () => ws.close(),
  }
}

/**
 * The lock that keeps one capture at a time on this machine. It is made whole and then linked in
 * place, which fails if one is there; a dead holder's lock is renamed away, which only one taker
 * can do, and put back if it turns out to be a live one.
 */
const takeLock = async () => {
  const { linkSync, readFileSync, renameSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const path = join(tmpdir(), 'shaderera-web-capture.lock')
  const mine = `${path}.${process.pid}`
  const holder = (file: string) => {
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
    const pid = Number(text)
    let alive = false
    try {
      alive = Number.isInteger(pid) && pid > 0 && process.kill(pid, 0)
    } catch (k) {
      alive = (k as NodeJS.ErrnoException).code === 'EPERM'
    }
    return { pid, alive }
  }
  const busy = (pid: number) =>
    new Error(`another capture is running (process ${pid}, ${path}): one capture runs at a time`)
  writeFileSync(mine, String(process.pid))
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(mine, path)
        return () => rmSync(path, { force: true })
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
      const h = holder(path)
      if (!h) continue
      if (h.alive) throw busy(h.pid)
      const stale = `${path}.stale.${process.pid}`
      try {
        renameSync(path, stale)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw e
      }
      const moved = holder(stale)
      if (moved?.alive) {
        // Another taker's fresh lock: put it back.
        try {
          linkSync(stale, path)
        } catch {}
        rmSync(stale, { force: true })
        throw busy(moved.pid)
      }
      rmSync(stale, { force: true })
    }
    throw new Error(`could not take ${path}`)
  } finally {
    rmSync(mine, { force: true })
  }
}

/** The flags every capture's Chrome starts with, besides its profile and the proxy's port. */
export const CHROME_FLAGS = [
  '--headless=new',
  '--remote-debugging-port=0',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-smooth-scrolling',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--disable-quic',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--proxy-bypass-list=<-loopback>',
]

/** The largest response held to read its bytes as served; a larger one is read at its end. */
const HELD_BODY_BYTES = 16 * 1024 * 1024
/** Every response, paused at its headers. */
const FETCH_PATTERNS = [{ urlPattern: '*', requestStage: 'Response' }]

/** A response the page loaded. `hashOf` is there only when the hash is not of the bytes served. */
type Served = { url: string; status: number; sha256: string; hashOf?: string }

/** How long a request may stay open before frames stop waiting for it, in real ms. */
const LONG_REQUEST_MS = 5000
/** How long a frame may wait for the page to settle, in real ms. */
const SETTLE_MS = 15000

/**
 * Captures the page and writes `<out>/tracks.json`. Returns its path and bytes. Refuses bad
 * options before Chrome starts, and a page whose own address is refused.
 */
export const captureWeb = async (options: CaptureOptions) => {
  const o = checkOptions(options)
  const log = o.log ?? (() => {})
  const { spawn } = await import('node:child_process')
  const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import(
    'node:fs'
  )
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { setTimeout: sleep } = await import('node:timers/promises')
  const { fileURLToPath } = await import('node:url')

  const url = await pageUrl(o.page)
  const parsed = new URL(url)
  if (parsed.protocol !== 'file:') {
    const c = await checkHost(parsed.hostname, { allowLocal: o.allowLocal })
    if ('refused' in c)
      throw new Error(
        `${url}: ${c.refused}${o.allowLocal ? '' : '; give --allow-local to capture a page on this machine or its network'}`,
      )
  }
  const chrome = await chromePath()
  if (!chrome) throw new Error('No Chrome found: install Google Chrome, or set CHROME to its path')
  if (!existsSync(chrome)) throw new Error(`CHROME is ${chrome}, which does not exist`)
  const clockSource = readFileSync(join(import.meta.dirname, 'inpage', 'clock.js'), 'utf8')
  const clockSha = await sha256(new TextEncoder().encode(clockSource))

  const release = await takeLock()
  const refused: Refused[] = []
  let proxy: Awaited<ReturnType<typeof startProxy>> | undefined
  let profile: string
  let browser: ReturnType<typeof spawn>
  try {
    proxy = await startProxy({ allowLocal: o.allowLocal, onRefused: (r) => refused.push(r) })
    profile = mkdtempSync(join(tmpdir(), 'shaderera-web-capture-'))
    browser = spawn(
      chrome,
      [
        ...CHROME_FLAGS,
        `--user-data-dir=${profile}`,
        `--proxy-server=http://127.0.0.1:${proxy.port}`,
        `--window-size=${o.viewport.width},${o.viewport.height}`,
        `--lang=${o.locale}`,
        '--do-not-de-elevate',
        'about:blank',
      ],
      { stdio: 'ignore' },
    )
  } catch (e) {
    await proxy?.close()
    release()
    throw e
  }
  const net = proxy
  let gone: string | undefined
  const exited = new Promise<void>((done) => {
    browser.once('exit', (code, signal) => {
      gone = `Chrome exited (${signal ?? code})`
      done()
    })
    browser.once('error', (e) => {
      gone = `Chrome could not start (${e.message})`
      done()
    })
  })
  let client: Awaited<ReturnType<typeof cdp>> | undefined
  let cleaned: Promise<void> | undefined
  const cleanup = () => {
    cleaned ??= end()
    return cleaned
  }
  const end = async () => {
    client?.close()
    if (!gone) browser.kill()
    await Promise.race([exited, sleep(5000, undefined, { ref: false })])
    if (!gone) browser.kill('SIGKILL')
    await net.close()
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    release()
  }
  const onSignal = (signal: NodeJS.Signals) => {
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    // Chrome writes its DevTools port and browser path to the profile once it listens.
    let lines: string[] = []
    for (let i = 0; i < 400 && !gone && !/^\d+$/.test(lines[0] ?? ''); i++) {
      try {
        lines = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')
      } catch {}
      if (!/^\d+$/.test(lines[0] ?? '')) await sleep(25)
    }
    if (!/^\d+$/.test(lines[0] ?? '') || !lines[1])
      throw new Error(`${chrome} did not open DevTools: ${gone ?? 'no port after 10 s'}`)
    const c = await cdp(`ws://127.0.0.1:${lines[0]}${lines[1].trim()}`)
    client = c
    const version = await c.send<{ product: string; userAgent: string }>('Browser.getVersion')
    const { targetInfos } = await c.send<{ targetInfos: { targetId: string; type: string }[] }>(
      'Target.getTargets',
    )
    const target = targetInfos.find((t) => t.type === 'page')
    if (!target) throw new Error('Chrome opened no page')
    const { sessionId: page } = await c.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })

    // What the page loads, from every session: open requests, and each response's sha256.
    const limits: Limit[] = []
    const open = new Map<string, { url: string; type?: string; at: number; long: boolean }>()
    const responses = new Map<string, { url: string; status: number }>()
    const hashed: Served[] = []
    const reading: Promise<void>[] = []
    const keyOf = (session: string | undefined, id: string) => `${session ?? ''} ${id}`
    // A response of a known length is held at its headers and its bytes read as they were served
    // (Network.getResponseBody gives a text body only as decoded text); one without a length may
    // be a stream, which holding would stop, so it is let through and read at the end.
    const served = new Map<string, Promise<Uint8Array | null>>()
    const received = new Map<string, number>()
    c.on<{
      requestId: string
      networkId?: string
      request: { method: string }
      responseStatusCode?: number
      responseErrorReason?: string
      responseHeaders?: { name: string; value: string }[]
    }>('Fetch.requestPaused', (p, s) => {
      const go = (method: string) => c.send(method, { requestId: p.requestId }, s).catch(() => {})
      const status = p.responseStatusCode
      if (p.responseErrorReason || status === undefined) return void go('Fetch.continueRequest')
      const length = Number(
        p.responseHeaders?.find((h) => h.name.toLowerCase() === 'content-length')?.value ?? '',
      )
      const kept =
        p.networkId !== undefined &&
        p.request.method !== 'HEAD' &&
        (status < 300 || status >= 400) &&
        Number.isInteger(length) &&
        length > 0 &&
        length <= HELD_BODY_BYTES
      if (!kept) return void go('Fetch.continueResponse')
      const body = c
        .send<{ body: string; base64Encoded: boolean }>(
          'Fetch.getResponseBody',
          { requestId: p.requestId },
          s,
        )
        .then(({ body, base64Encoded }) =>
          base64Encoded ? new Uint8Array(Buffer.from(body, 'base64')) : null,
        )
        .catch(() => null)
      served.set(keyOf(s, p.networkId as string), body)
      void body.finally(() => go('Fetch.continueResponse'))
    })
    c.on<{ requestId: string; dataLength: number }>('Network.dataReceived', (p, s) => {
      const key = keyOf(s, p.requestId)
      received.set(key, (received.get(key) ?? 0) + p.dataLength)
    })
    c.on<{ requestId: string; request: { url: string }; type?: string }>(
      'Network.requestWillBeSent',
      (p, s) => {
        if (p.type === 'EventSource' || /^(data|blob):/.test(p.request.url)) return
        open.set(keyOf(s, p.requestId), {
          url: p.request.url,
          type: p.type,
          at: performance.now(),
          long: false,
        })
      },
    )
    c.on<{ requestId: string; response: { url: string; status: number } }>(
      'Network.responseReceived',
      (p, s) => {
        if (/^(data|blob):/.test(p.response.url)) return
        responses.set(keyOf(s, p.requestId), { url: p.response.url, status: p.response.status })
      },
    )
    c.on<{ requestId: string }>('Network.loadingFinished', (p, s) => {
      const key = keyOf(s, p.requestId)
      open.delete(key)
      const r = responses.get(key)
      const held = served.get(key)
      served.delete(key)
      if (!r) return
      const read = async () => {
        let bytes = held ? await held : null
        let hashOf: string | undefined
        if (!bytes && r.url.startsWith('file:')) {
          try {
            bytes = new Uint8Array(readFileSync(fileURLToPath(r.url)))
          } catch {}
        }
        if (!bytes) {
          const got = await c.send<{ body: string; base64Encoded: boolean }>(
            'Network.getResponseBody',
            { requestId: p.requestId },
            s,
          )
          if (got.base64Encoded) bytes = new Uint8Array(Buffer.from(got.body, 'base64'))
          else {
            // Chrome decoded it with its charset; its bytes as served are gone.
            bytes = new TextEncoder().encode(got.body)
            hashOf = 'text-as-utf8'
          }
          if (bytes.length === 0 && (received.get(key) ?? 0) > 0) {
            limits.push({ where: r.url, reason: 'its body was not kept by Chrome: it has no hash' })
            return
          }
        }
        hashed.push({ ...r, sha256: await sha256(bytes), ...(hashOf ? { hashOf } : {}) })
      }
      reading.push(
        read().catch((e: Error) => {
          limits.push({ where: r.url, reason: `its body could not be read: ${e.message}` })
        }),
      )
    })
    c.on<{ requestId: string; errorText: string; canceled?: boolean; blockedReason?: string }>(
      'Network.loadingFailed',
      (p, s) => {
        const key = keyOf(s, p.requestId)
        const r = open.get(key)
        open.delete(key)
        if (!r || p.canceled || p.errorText === 'net::ERR_ABORTED') return
        // A request the proxy refused is listed once, with the proxy's reason.
        if (p.errorText === 'net::ERR_TUNNEL_CONNECTION_FAILED') return
        limits.push({ where: r.url, reason: `it did not load: ${p.errorText}` })
      },
    )

    // Frames and workers have clocks of their own, which the capture does not hold.
    const IFRAME = 'an iframe: its own clock is not held, so it runs on real time'
    const realTime = new Map<string, string>()
    c.on<{ frame: { id: string; parentId?: string; url: string } }>(
      'Page.frameNavigated',
      (p, s) => {
        if (s === page && p.frame.parentId) realTime.set(`iframe ${p.frame.url}`, IFRAME)
      },
    )
    c.on<{
      sessionId: string
      targetInfo: { type: string; url: string }
      waitingForDebugger: boolean
    }>('Target.attachedToTarget', (p, parent) => {
      // Our own page attaches on the browser's session; frames and workers on the page's.
      if (parent === undefined) return
      const { type, url: at } = p.targetInfo
      const kind = type.replace('_', ' ')
      realTime.set(`${kind} ${at}`, type === 'iframe' ? IFRAME : `a ${kind}: it runs on real time`)
      const s = p.sessionId
      void (async () => {
        try {
          await c.send('Network.enable', {}, s)
          await c.send('Fetch.enable', { patterns: FETCH_PATTERNS }, s).catch(() => {})
          await c.send(
            'Target.setAutoAttach',
            { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
            s,
          )
        } catch {}
        await c.send('Runtime.runIfWaitingForDebugger', {}, s).catch(() => {})
      })()
    })

    await c.send('Page.enable', {}, page)
    await c.send(
      'Network.enable',
      { maxTotalBufferSize: 512 * 1024 * 1024, maxResourceBufferSize: 128 * 1024 * 1024 },
      page,
    )
    await c.send('Network.setBypassServiceWorker', { bypass: true }, page)
    await c.send('Fetch.enable', { patterns: FETCH_PATTERNS }, page)
    await c.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: o.viewport.width,
        height: o.viewport.height,
        deviceScaleFactor: o.devicePixelRatio,
        mobile: false,
      },
      page,
    )
    await c.send(
      'Emulation.setEmulatedMedia',
      { features: Object.entries(o.media).map(([name, value]) => ({ name, value })) },
      page,
    )
    await c.send('Emulation.setTimezoneOverride', { timezoneId: o.timezone }, page)
    await c.send('Emulation.setLocaleOverride', { locale: o.locale }, page)
    await c.send(
      'Network.setUserAgentOverride',
      { userAgent: version.userAgent, acceptLanguage: o.locale },
      page,
    )
    if (o.cpuThrottle > 1)
      await c.send('Emulation.setCPUThrottlingRate', { rate: o.cpuThrottle }, page)
    await c.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      page,
    )
    // A still names the web fonts the page loads, as Chrome reports them: their files are not kept.
    const fontFaces: Record<string, unknown>[] = []
    if (o.mode === 'still') {
      c.on<{ font?: Record<string, unknown> }>('CSS.fontsUpdated', (p, s) => {
        if (s === page && p.font) fontFaces.push(p.font)
      })
      await c.send('DOM.enable', {}, page)
      await c.send('CSS.enable', {}, page)
    }
    // The clock holds the top frame only: a frame's clock that nothing advances would stop it.
    const config = JSON.stringify({
      seed: o.seed,
      rafHz: o.rafHz,
      timeOrigin: o.timeOrigin,
      epoch: o.epoch,
      free: o.settle === 'loaded',
    })
    await c.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: `if (self === self.top) {\n${clockSource}(${config})\n}` },
      page,
    )

    const evaluate = async <T>(expression: string): Promise<T> => {
      const r = await c.send<{
        result: { value?: T }
        exceptionDetails?: { text: string; exception?: { description?: string } }
      }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, page)
      if (r.exceptionDetails)
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      return r.result.value as T
    }

    const date = new Date().toISOString()
    let loaded = false
    c.on('Page.loadEventFired', (_p, s) => {
      if (s === page) loaded = true
    })
    log(`loading ${url}`)
    const nav = await c.send<{ errorText?: string }>('Page.navigate', { url }, page)
    if (nav.errorText) {
      const why = refused.find((r) => url.startsWith(r.where) || r.where.includes(parsed.host))
      throw new Error(`Chrome could not load ${url}: ${why?.reason ?? nav.errorText}`)
    }
    for (let i = 0; !loaded; i++) {
      if (gone) throw new Error(gone)
      if (i * 25 > 60000) throw new Error(`${url} did not finish loading in 60 s`)
      await sleep(25)
    }
    const clock = await evaluate<string | null>('self.__shadereraClock?.version ?? null')
    if (clock === null) throw new Error(`the clock did not load in ${url}`)
    // A capture holds one document. The loaded one is marked, and every read, advance and input
    // after this checks the mark in the same call: a new document (a link clicked, the page
    // setting location) has its own clock and none of what was declared, so it is refused.
    await evaluate('self.__shadereraHeld = true')
    let navigatedTo: string | undefined
    c.on<{ frame: { parentId?: string; url: string } }>('Page.frameNavigated', (p, s) => {
      if (s === page && !p.frame.parentId) navigatedTo = p.frame.url
    })
    let lastInput: { kind: string; ms: number } | undefined
    const held = async <T>(expression: string, ms: number): Promise<T> => {
      const r = await evaluate<T | { navigated: string }>(
        `self.__shadereraHeld === true ? (${expression}) : { navigated: location.href }`,
      )
      const away =
        navigatedTo ??
        (r !== null && typeof r === 'object' && 'navigated' in r ? r.navigated : undefined)
      if (away !== undefined)
        throw new Error(
          lastInput
            ? `the page navigated to ${away} after the ${lastInput.kind} at ${lastInput.ms} ms: a capture holds one document`
            : `the page navigated itself to ${away} by ${ms} ms: a capture holds one document`,
        )
      return r as T
    }
    // With --settle loaded the clock ran on real time until the load event; it is frozen now.
    const loadedAt = await evaluate<number>('self.__shadereraClock.frozen()')
    await evaluate('document.fonts.ready.then(() => true)')
    const selectors = [
      ...o.track.map((sel) => ['--track', sel] as const),
      ...(o.trigger.target ? [['--target', o.trigger.target] as const] : []),
      ...(o.root !== undefined ? [['--root', o.root] as const] : []),
    ]
    for (const [flag, sel] of selectors) {
      const ok = await evaluate<boolean>(
        `(() => { try { document.querySelector(${JSON.stringify(sel)}); return true } catch { return false } })()`,
      )
      if (!ok) throw new Error(`${flag} ${JSON.stringify(sel)} is not a CSS selector`)
    }
    for (const s of o.styles ?? []) {
      const known = await evaluate<boolean>(`CSS.supports(${JSON.stringify(s)}, 'inherit')`)
      if (!known) throw new Error(`--style ${s}: this Chrome knows no such CSS property`)
    }

    // The network and the page's own pending work (worker replies, video seeks) settle before a
    // frame is read. A request open for LONG_REQUEST_MS no longer holds frames.
    const settle = async (time: number) => {
      const started = performance.now()
      for (let calm = 0; calm < 2; ) {
        if (gone) throw new Error(gone)
        const now = performance.now()
        let waiting = 0
        for (const r of open.values()) {
          if (r.long) continue
          if (now - r.at > LONG_REQUEST_MS) {
            r.long = true
            limits.push({
              where: r.url,
              reason: `a request still open after ${LONG_REQUEST_MS / 1000} s: frames from here on do not wait for it`,
              from: time,
            })
          } else waiting++
        }
        const busy = waiting > 0 ? 1 : await evaluate<number>('self.__shadereraClock.busy()')
        calm = waiting === 0 && busy === 0 ? calm + 1 : 0
        if (now - started > SETTLE_MS) {
          limits.push({
            where: url,
            reason: `the page did not settle in ${SETTLE_MS / 1000} s; the frame was read as it was`,
            from: time,
            to: time,
          })
          return
        }
        if (calm < 2) await sleep(calm === 0 ? 5 : 2)
      }
    }

    type Read = {
      matches: number
      box: number[]
      opacity: number
      matrix: number[]
      is3d: boolean
      origin: number[]
      unread: string[]
    } | null
    const tracks = new Map<string, Sample[]>()
    const sampled = (element: string, channel: string) => {
      const key = JSON.stringify([element, channel])
      let s = tracks.get(key)
      if (!s) {
        s = []
        tracks.set(key, s)
      }
      return s
    }
    // What each element showed that the channels cannot hold exactly, with the times it showed.
    const spans = new Map<string, { where: string; reason: string; from: number; to: number }>()
    const note = (where: string, reason: string, time: number) => {
      const key = JSON.stringify([where, reason])
      const s = spans.get(key)
      if (s) s.to = time
      else spans.set(key, { where, reason, from: time, to: time })
    }
    const declared: { element: string; type: string; [key: string]: unknown }[] = []
    const advanceTo = (ms: number) =>
      held(
        `(() => { const c = self.__shadereraClock; c.sync(); return c.advanceTo(${JSON.stringify(ms)}) })()`,
        ms,
      )
    const afterInput = (ms: number) => held('self.__shadereraClock.afterInput()', ms)

    // The trigger's inputs, each sent at its own time over CDP, as a person's would arrive.
    const inputs = inputsOf(o.trigger, o.rafHz)
    const trigger: Record<string, unknown> = { ...o.trigger }
    const mouse = (type: string, x: number, y: number, more: Record<string, unknown> = {}) =>
      c.send('Input.dispatchMouseEvent', { type, x, y, pointerType: 'mouse', ...more }, page)
    let scrollFrom = 0
    const pointer = async (ms: number) => {
      const sel = o.trigger.target ?? null
      const p = await held<{
        x: number
        y: number
        boxed: boolean
        inView: boolean
        over: boolean
        hit: string
      } | null>(`(${POINT})(${JSON.stringify(sel)})`, ms)
      const flag = `--target ${JSON.stringify(sel)}`
      if (!p) throw new Error(`${flag} matches nothing at ${ms} ms, when the input is sent`)
      if (!p.boxed)
        throw new Error(
          `${flag} has no box at ${ms} ms (display: none?), so the pointer cannot reach it`,
        )
      if (!p.inView)
        throw new Error(
          `${flag}: the centre of its box (${p.x}, ${p.y}) is outside the ${o.viewport.width}x${o.viewport.height} viewport at ${ms} ms, so the pointer cannot reach it`,
        )
      if (!p.over)
        limits.push({
          where: sel as string,
          reason: `the pointer at its centre (${p.x}, ${p.y}) is over ${p.hit}, which got the input`,
          from: ms / 1000,
          to: ms / 1000,
        })
      trigger.pointer = { x: p.x, y: p.y }
      // Without a target the wheel's point hovers whatever is there: name it, so a hover state in
      // the capture can be read back to it.
      if (sel === null) trigger.over = p.hit
      return p
    }
    const send = async (input: Input) => {
      const pointed = input.kind === 'hover' || input.kind === 'click' || input.kind === 'leave'
      lastInput = pointed
        ? { kind: input.kind, ms: input.ms }
        : { kind: 'scroll', ms: o.trigger.at as number }
      if (input.kind === 'hover' || input.kind === 'click') {
        const { x, y } = await pointer(input.ms)
        await mouse('mouseMoved', x, y)
        if (input.kind === 'click') {
          await mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 })
          await mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 })
        }
      } else if (input.kind === 'leave') {
        // Out of the viewport, so the pointer goes over nothing else.
        await mouse('mouseMoved', -1, -1)
      } else if (input.kind === 'scroll-start') {
        // The pointer is over what the wheel turns over, as a person's is: it hovers it.
        const { x, y } = await pointer(input.ms)
        await mouse('mouseMoved', x, y)
        scrollFrom = await held<number>('scrollY', input.ms)
      } else {
        const { x, y } = trigger.pointer as { x: number; y: number }
        const distance = (o.trigger.scrollTo as number) - scrollFrom
        const delta = wheelDelta(distance, input.step, input.of)
        if (delta !== 0) await mouse('mouseWheel', x, y, { deltaX: 0, deltaY: delta })
        if (input.step === input.of) {
          await afterInput(input.ms)
          const reached = await held<number>('scrollY', input.ms)
          if (reached !== o.trigger.scrollTo)
            limits.push({
              where: WINDOW,
              reason: `the wheel moved ${distance} px from scrollY ${scrollFrom}, and the window scrolled to ${reached}, not --scroll-to ${o.trigger.scrollTo}`,
              from: (o.trigger.at as number) / 1000,
              to: input.ms / 1000,
            })
          return
        }
      }
      await afterInput(input.ms)
    }

    log(
      o.mode === 'still'
        ? `capturing the style at ${o.still} ms (rafHz ${o.rafHz})`
        : `capturing ${o.frames} frames at ${o.fps} fps (rafHz ${o.rafHz})`,
    )
    const batches = batchesAt(inputs, o.times)
    for (const [k, ms] of o.times.entries()) {
      const time = ms / 1000
      for (const { input, ms: at } of batches[k] ?? []) {
        await advanceTo(at)
        await settle(at / 1000)
        await send({ ...input, ms: at })
      }
      await advanceTo(ms)
      await settle(time)
      if (o.mode === 'still') break
      const read = await held<{
        elements: Read[]
        scroll: number[]
        animations: typeof declared
      }>(`(${READ})(${JSON.stringify(o.track)})`, ms)
      declared.push(...read.animations)
      WINDOW_CHANNELS.forEach(([channel], i) => {
        sampled(WINDOW, channel).push([time, read.scroll[i] as number])
      })
      read.elements.forEach((r, i) => {
        const el = o.track[i] as string
        if (r === null) {
          for (const [channel] of CHANNELS) sampled(el, channel).push([time, null])
          note(el, 'no element matches it', time)
          return
        }
        if (r.matches > 1)
          note(el, `${r.matches} elements match it: the first in document order is tracked`, time)
        if (r.is3d)
          note(
            el,
            'a 3D transform: rotate, skewX, scaleX and scaleY are of its 2D part only; x, y, width and height are the box as drawn',
            time,
          )
        for (const u of r.unread)
          note(el, `${u} could not be read: the transform channels leave it out`, time)
        const t = decompose(r.matrix)
        const rotate = sampled(el, 'rotate')
        const before = rotate.at(-1)?.[1] ?? null
        const values: Record<string, number> = {
          x: r.box[0] as number,
          y: r.box[1] as number,
          width: r.box[2] as number,
          height: r.box[3] as number,
          opacity: r.opacity,
          ...t,
          rotate: unwrap(t.rotate, before),
          originX: r.origin[0] as number,
          originY: r.origin[1] as number,
        }
        for (const [channel] of CHANNELS) {
          const v = values[channel] as number
          sampled(el, channel).push([time, Number.isFinite(v) ? v : null])
        }
      })
      if (k % Math.max(1, Math.round(o.fps as number)) === 0) log(`  ${time.toFixed(2)} s`)
    }
    // A still: the style facts at its moment, once fonts that started loading have loaded.
    let style: Awaited<ReturnType<typeof readStyle>> | undefined
    if (o.mode === 'still') {
      await held('document.fonts.ready.then(() => true)', o.still as number)
      style = await readStyle((method, params) => c.send(method, params, page), {
        root: o.root,
        styles: o.styles,
        fontFaces,
      })
      limits.push(...style.limits)
    }
    // Bodies are read as their loads finish; reading one can come after the last frame.
    for (let n = 0; n < reading.length; ) {
      const m = reading.length
      await Promise.all(reading.slice(n, m))
      n = m
    }

    for (const [where, reason] of realTime) limits.push({ where, reason })
    for (const s of spans.values()) limits.push(s)
    for (const r of refused) limits.push({ where: r.where, reason: r.reason })
    // One entry for each distinct limit, in a stable order: the page reports them as they come.
    const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
    const distinct = [...new Map(limits.map((l) => [JSON.stringify(l), l])).values()].sort(
      (a, b) =>
        byCode(a.where, b.where) || byCode(a.reason, b.reason) || (a.from ?? -1) - (b.from ?? -1),
    )
    const uniqueResponses = [...new Map(hashed.map((r) => [JSON.stringify(r), r])).values()]
    const tool = {
      script: 'tools/capture-web.ts',
      version: VERSION,
      chrome: version.product,
      userAgent: version.userAgent,
      chromeFlags: CHROME_FLAGS,
      clock: { script: 'tools/inpage/clock.js', version: clock, sha256: clockSha },
    }
    // What the page's clocks read, when they froze and what started the motion: both kinds.
    const clockParams = {
      rafHz: o.rafHz,
      seed: o.seed,
      timeOrigin: o.timeOrigin,
      clockDate: o.clockDate,
      timezone: o.timezone,
      locale: o.locale,
      settle: o.settle,
      trigger,
      media: o.media,
      allowLocal: o.allowLocal,
    }
    const frame = {
      width: o.viewport.width,
      height: o.viewport.height,
      pixelRatio: o.devicePixelRatio,
    }
    const viewport = { width: o.viewport.width, height: o.viewport.height }
    const { devicePixelRatio } = o
    const hashes = uniqueResponses
    // The real time the load took, which --settle loaded froze the page's clocks after.
    const loadTime = o.settle === 'loaded' ? { loadedAt: loadedAt / 1000 } : {}
    mkdirSync(o.out, { recursive: true })

    if (style) {
      const png = style.png
      const screenshot = { path: 'style.png', ...pngSize(png), sha256: await sha256(png) }
      const json = styleJson({
        format: 'shaderera.analysis/1',
        kind: 'reference-style',
        source: { url, date, viewport, devicePixelRatio, responses: hashes, ...loadTime },
        tool,
        params: { still: o.still, root: o.root, styles: o.styles, ...clockParams },
        frame,
        scroll: style.scroll,
        screenshot,
        elements: style.elements,
        texts: style.texts,
        fontFaces: style.fontFaces,
        limits: distinct,
      })
      const path = join(o.out, 'style.json')
      const shot = join(o.out, screenshot.path)
      writeFileSync(shot, png)
      writeFileSync(path, json)
      return { path, json, limits: distinct, screenshot: shot }
    }

    const unitOf = new Map([...CHANNELS, ...WINDOW_CHANNELS])
    const trackList: Track[] = [...tracks].map(([key, samples]) => {
      const [element, channel] = JSON.parse(key) as [string, string]
      return { element, channel, unit: unitOf.get(channel) as string, samples }
    })
    const json = tracksJson({
      format: 'shaderera.analysis/1',
      kind: 'reference-tracks',
      source: { url, date, viewport, devicePixelRatio, responses: hashes, ...loadTime },
      tool,
      params: { fps: o.fps, duration: o.duration, track: o.track, ...clockParams },
      frame,
      tracks: trackList,
      declared,
      limits: distinct,
    })
    const path = join(o.out, 'tracks.json')
    writeFileSync(path, json)
    return { path, json, limits: distinct }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    await cleanup()
  }
}

if (import.meta.main) {
  const { parseArgs } = await import('node:util')
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      track: { type: 'string', multiple: true },
      fps: { type: 'string' },
      duration: { type: 'string' },
      viewport: { type: 'string' },
      rafHz: { type: 'string' },
      seed: { type: 'string' },
      dpr: { type: 'string' },
      media: { type: 'string', multiple: true },
      'allow-local': { type: 'boolean' },
      'cpu-throttle': { type: 'string' },
      'time-origin': { type: 'string' },
      'clock-date': { type: 'string' },
      timezone: { type: 'string' },
      settle: { type: 'string' },
      trigger: { type: 'string' },
      target: { type: 'string' },
      at: { type: 'string' },
      'scroll-to': { type: 'string' },
      'scroll-ms': { type: 'string' },
      still: { type: 'string' },
      root: { type: 'string' },
      style: { type: 'string', multiple: true },
      locale: { type: 'string' },
    },
  })
  const number = (name: string, v: string | undefined) => {
    if (v === undefined) return undefined
    const n = Number(v)
    if (v.trim() === '' || !Number.isFinite(n)) throw new Error(`--${name} ${v} is not a number`)
    return n
  }
  try {
    if (positionals.length !== 1)
      throw new Error(
        'usage: node tools/capture-web.ts <url|file> --out <dir> --track <selector> --fps <n> --duration <s> --viewport <width>x<height>\n   or: node tools/capture-web.ts <url|file> --out <dir> --still <ms> --rafHz <n> --viewport <width>x<height>',
      )
    const still = values.still !== undefined
    for (const name of still ? (['viewport'] as const) : (['fps', 'duration', 'viewport'] as const))
      if (values[name] === undefined)
        throw new Error(`give --${name}: it changes every ${still ? 'box' : 'sample'}`)
    const vp = /^(\d+)x(\d+)$/.exec(values.viewport ?? '')
    if (!vp) throw new Error(`--viewport ${values.viewport} is not <width>x<height>, like 1280x720`)
    const media: Record<string, string> = {}
    for (const m of values.media ?? []) {
      const at = m.indexOf('=')
      if (at < 1)
        throw new Error(`--media ${m} is not <name>=<value>, like prefers-color-scheme=dark`)
      media[m.slice(0, at)] = m.slice(at + 1)
    }
    const { path, limits } = await captureWeb({
      page: positionals[0] as string,
      out: values.out ?? '',
      track: values.track ?? (still ? undefined : []),
      fps: number('fps', values.fps),
      duration: number('duration', values.duration),
      still: number('still', values.still),
      root: values.root,
      styles: values.style,
      viewport: { width: Number(vp[1]), height: Number(vp[2]) },
      rafHz: number('rafHz', values.rafHz),
      seed: number('seed', values.seed),
      devicePixelRatio: number('dpr', values.dpr),
      media,
      allowLocal: values['allow-local'] ?? false,
      cpuThrottle: number('cpu-throttle', values['cpu-throttle']),
      timeOrigin: number('time-origin', values['time-origin']),
      clockDate: values['clock-date'],
      timezone: values.timezone,
      settle: values.settle as Settle | undefined,
      trigger: values.trigger as Trigger | undefined,
      target: values.target,
      at: number('at', values.at),
      scrollTo: number('scroll-to', values['scroll-to']),
      scrollMs: number('scroll-ms', values['scroll-ms']),
      locale: values.locale,
      log: (line) => console.error(line),
    })
    console.log(path)
    for (const l of limits) console.error(`limit: ${l.where}: ${l.reason}`)
  } catch (e) {
    console.error((e as Error).message)
    process.exitCode = 1
  }
}
