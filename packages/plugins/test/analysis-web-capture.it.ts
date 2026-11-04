// analysis-web-capture, in the machine's own Chrome: the research's experiments as tests. Pages
// in test/web-capture/libraries/ run GSAP, motion and react-spring themselves (exact versions,
// devDependencies bundled here by esbuild); the other pages in test/web-capture/ copy their
// clocks and clamps by hand, and add CSS, Web Animations, absolute time and animations started
// off a timer. Two captures give the same bytes, but for source.date; a capture under 6x CPU
// throttling gives the same bytes as one without; with rafHz equal to the fps, a JS linear move
// on GSAP's ticker matches a CSS one within 0.5 ms. A page that reaches for this machine is
// refused without --allow-local, and the local server sees nothing; with it, each response is
// hashed as served. Skipped, with the reason, when there is no Chrome.

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { type Host, sha256 } from '@shaderera/core'
import { build } from 'esbuild'

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
for (const name of ['gsap', 'motion', 'spring']) {
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
const sameEveryTime = async (page: string, trackList: string[]) => {
  const first = await capture({ page, track: trackList })
  const again = await capture({ page, track: trackList })
  const slow = await capture({ page, track: trackList, cpuThrottle: 6 })
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

test('the capture is read by the reader of reference tracks', { skip }, async () => {
  const out = join(outs, 'read')
  const { path } = await captureWeb({
    page: fixture('linear.html'),
    out,
    track: ['#css', '#missing'],
    fps: 10,
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
        duration: 0.3,
        viewport: { width: 800, height: 400 },
      }),
      /loopback address; give --allow-local/,
    )
  } finally {
    server.close()
  }
})

test.after(() => rmSync(outs, { recursive: true, force: true }))
