// analysis-web-capture, in the machine's own Chrome: the research's experiments as tests, on
// fixture pages in test/web-capture/ that move as GSAP, motion and react-spring do (their clocks,
// lag smoothing and delta clamps, with none of their code), plus CSS and Web Animations. Two
// captures give the same bytes, but for source.date; a capture under 6x CPU throttling gives the
// same bytes as one without; with rafHz equal to the fps, a JS linear move matches a CSS one
// within 0.5 ms. A page that reaches for this machine is refused without --allow-local, and the
// local server sees nothing. Skipped, with the reason, when there is no Chrome.

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { type Host, sha256 } from '@shaderera/core'

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
  const server = createServer((req, res) => {
    hits.push(req.url ?? '')
    res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/plain' })
    res.end(`body of ${req.url}`)
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
    assert.deepEqual([...hits].sort(), ['/pixel', '/secret'])
    const secret = await sha256(new TextEncoder().encode('body of /secret'))
    assert.ok(
      'responses' in allowed.source &&
        allowed.source.responses.some((r) => r.url.endsWith('/secret') && r.sha256 === secret),
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
