// analysis-web-capture, without Chrome: copied into a project the way `add` lays it out. The
// address check refuses loopback, private, link-local and cloud metadata addresses (IPv4, IPv6,
// IPv4 inside IPv6) and a name that resolves to one; the proxy Chrome goes out through refuses
// such a request before it connects, and lets it through with allowLocal. Bad options are
// refused before anything starts, each trigger takes only its own settings and sends its inputs
// at their times, and a transform matrix comes apart into channels that build it back. A still
// takes its own settings and is on an animation frame; its reference-style artifact is written in
// one order, read back, and refused with a changed screenshot or a malformed field. The captures
// themselves are in analysis-web-capture.it.ts.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'analysis-web-capture')
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
const { checkHost, localKind, refusedAddress, refusedName, startProxy } = (await from(
  'tools/web-capture-net.ts',
)) as typeof import('../analysis-web-capture/tools/web-capture-net.ts')
const { batchesOf, checkOptions, decompose, frameMs, inputsOf, pageUrl, unwrap, wheelDelta } =
  (await from(
    'tools/capture-web.ts',
  )) as typeof import('../analysis-web-capture/tools/capture-web.ts')
const { styleJson } = (await from(
  'tools/reference-style.ts',
)) as typeof import('../analysis-web-capture/tools/reference-style.ts')
const { pngSize, STYLES } = (await from(
  'tools/web-capture-style.ts',
)) as typeof import('../analysis-web-capture/tools/web-capture-style.ts')
const { loadStyle, styleOf, textsOf } = (await from(
  'src/reference/style.ts',
)) as typeof import('../analysis-web-capture/src/reference/style.ts')
const { loadTracks } = (await from(
  'src/reference/tracks.ts',
)) as typeof import('../analysis-reference-tracks/src/reference/tracks.ts')
type StyleDoc = import('../analysis-web-capture/tools/reference-style.ts').StyleDoc

test('the address check refuses every address that is not public', () => {
  const refused: [string, string][] = [
    ['127.0.0.1', 'loopback'],
    ['127.255.0.9', 'loopback'],
    ['0.0.0.0', 'this network'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.10.20', 'link-local'],
    ['169.254.169.254', 'cloud metadata'],
    ['169.254.170.2', 'cloud metadata'],
    ['100.100.100.200', 'cloud metadata'],
    ['100.64.0.1', 'shared address space'],
    ['192.0.2.7', 'documentation'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.251', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'private (unique local)'],
    ['fdff:ffff::1', 'private (unique local)'],
    ['fd00:ec2::254', 'cloud metadata'],
    ['fe80::1', 'link-local'],
    ['fe80::1%en0', 'link-local'],
    ['febf:ffff::1', 'link-local'],
    ['fec0::1', 'site-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['::ffff:127.0.0.1', 'loopback (127.0.0.1)'],
    ['::ffff:7f00:1', 'loopback (127.0.0.1)'],
    ['::ffff:169.254.169.254', 'cloud metadata (169.254.169.254)'],
    ['::ffff:192.168.0.1', 'private (192.168.0.1)'],
    ['64:ff9b::a00:1', 'private (10.0.0.1)'],
    ['2002:7f00:1::1', 'loopback (127.0.0.1)'],
    ['::127.0.0.1', 'reserved'],
    ['[::1]', 'loopback'],
  ]
  for (const [ip, kind] of refused) assert.equal(refusedAddress(ip), kind, ip)
  for (const ip of [
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '172.15.255.255',
    '100.128.0.1',
    '169.255.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:81b::200e',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])
    assert.equal(refusedAddress(ip), undefined, ip)
  assert.throws(() => refusedAddress('example.com'), /not an IP address/)
  assert.throws(() => refusedAddress('1.2.3.256'), /not an IP address/)
})

test('names that reach this machine or a metadata service are refused before DNS', () => {
  assert.equal(refusedName('localhost'), 'loopback')
  assert.equal(refusedName('LocalHost.'), 'loopback')
  assert.equal(refusedName('app.localhost'), 'loopback')
  assert.equal(refusedName('metadata.google.internal'), 'cloud metadata')
  assert.equal(refusedName('metadata.goog'), 'cloud metadata')
  assert.equal(refusedName('example.com'), undefined)
  assert.equal(refusedName('notlocalhost.com'), undefined)
  // allowLocal lets this machine and its network through, never a metadata service.
  assert.ok(localKind('loopback'))
  assert.ok(localKind('private (unique local)'))
  assert.ok(localKind('link-local'))
  assert.ok(localKind('loopback (127.0.0.1)'))
  assert.ok(!localKind('cloud metadata'))
  assert.ok(!localKind('cloud metadata (169.254.169.254)'))
  assert.ok(!localKind('multicast'))
})

test('a name is judged by every address it resolves to', async () => {
  const dns = (table: Record<string, string[]>) => async (host: string) => {
    const found = table[host]
    if (!found) throw new Error(`ENOTFOUND ${host}`)
    return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  const lookup = dns({
    'rebind.example': ['127.0.0.1'],
    'mixed.example': ['93.184.215.14', '10.0.0.5'],
    'public.example': ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
    'meta.example': ['169.254.169.254'],
  })
  const r = await checkHost('rebind.example', { lookup })
  assert.ok('refused' in r)
  assert.equal(r.refused, 'rebind.example is 127.0.0.1, a loopback address')
  const mixed = await checkHost('mixed.example', { lookup })
  assert.ok('refused' in mixed && mixed.kind === 'private')
  assert.deepEqual(await checkHost('public.example', { lookup }), {
    addresses: [
      { address: '93.184.215.14', family: 4 },
      { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 },
    ],
  })
  assert.ok('addresses' in (await checkHost('rebind.example', { lookup, allowLocal: true })))
  const meta = await checkHost('meta.example', { lookup, allowLocal: true })
  assert.ok('refused' in meta && meta.kind === 'cloud metadata')
  const name = await checkHost('metadata.google.internal', { lookup, allowLocal: true })
  assert.ok('refused' in name && name.kind === 'cloud metadata')
  const ip = await checkHost('[::ffff:127.0.0.1]', { lookup })
  assert.ok(
    'refused' in ip && ip.refused === '[::ffff:127.0.0.1] is a loopback (127.0.0.1) address',
  )
  const gone = await checkHost('nowhere.example', { lookup })
  assert.ok('refused' in gone && gone.kind === 'unresolved')
})

test('the proxy refuses a request to a name that resolves to this machine, before connecting', async () => {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? '')
    res.end('local')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  const lookup = async () => [{ address: '127.0.0.1', family: 4 }]
  const through = async (allowLocal: boolean) => {
    const refused: { where: string; reason: string }[] = []
    const proxy = await startProxy({ allowLocal, lookup, onRefused: (r) => refused.push(r) })
    const get = await new Promise<{ status: number; body: string }>((done, fail) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          path: `http://rebind.example:${port}/secret`,
          headers: { host: `rebind.example:${port}` },
        },
        (res) => {
          let body = ''
          res.on('data', (d) => {
            body += d
          })
          res.on('end', () => done({ status: res.statusCode ?? 0, body }))
        },
      )
      req.on('error', fail)
      req.end()
    })
    const tunnel = await new Promise<number>((done, fail) => {
      const req = request({
        host: '127.0.0.1',
        port: proxy.port,
        method: 'CONNECT',
        path: `rebind.example:${port}`,
      })
      req.on('connect', (res, socket) => {
        socket.destroy()
        done(res.statusCode ?? 0)
      })
      req.on('error', fail)
      req.end()
    })
    await proxy.close()
    return { get, tunnel, refused }
  }
  try {
    const no = await through(false)
    assert.equal(no.get.status, 403)
    assert.equal(no.tunnel, 403)
    assert.deepEqual(hits, [], 'the local server saw nothing')
    assert.deepEqual(
      no.refused.map((r) => r.where),
      [`http://rebind.example:${port}/secret`, `rebind.example:${port}`],
    )
    assert.match(
      no.refused[0]?.reason ?? '',
      /^refused: rebind\.example is 127\.0\.0\.1, a loopback address; --allow-local/,
    )
    const yes = await through(true)
    assert.deepEqual(yes.get, { status: 200, body: 'local' })
    assert.equal(yes.tunnel, 200)
    assert.deepEqual(hits, ['/secret'])
    assert.deepEqual(yes.refused, [])
  } finally {
    server.close()
  }
})

test('options are checked before anything starts', async () => {
  const base = {
    page: 'https://example.com/',
    out: 'references/hero',
    track: ['.hero h1'],
    fps: 24,
    duration: 2,
    viewport: { width: 1280, height: 720 },
  }
  const o = checkOptions(base)
  assert.equal(o.rafHz, 24, 'rafHz is the fps when left out')
  assert.equal(o.seed, 1)
  assert.equal(o.frames, 49)
  assert.deepEqual(o.media, {
    'prefers-color-scheme': 'light',
    'prefers-reduced-motion': 'no-preference',
  })
  assert.equal(checkOptions({ ...base, rafHz: 72 }).rafHz, 72)
  assert.equal(checkOptions({ ...base, fps: 30, duration: 1 }).frames, 31)
  assert.throws(
    () => checkOptions({ ...base, rafHz: 60 }),
    /--rafHz 60 is not a whole multiple of --fps 24.*24, 48, 72/,
  )
  assert.throws(() => checkOptions({ ...base, rafHz: 12 }), /not a whole multiple/)
  assert.throws(() => checkOptions({ ...base, fps: 0 }), /--fps 0/)
  assert.throws(() => checkOptions({ ...base, duration: -1 }), /--duration -1/)
  assert.throws(() => checkOptions({ ...base, track: [] }), /--track/)
  assert.throws(() => checkOptions({ ...base, track: ['a', 'a'] }), /twice/)
  assert.throws(
    () => checkOptions({ ...base, viewport: { width: 12.5, height: 720 } }),
    /--viewport 12.5x720/,
  )
  assert.throws(() => checkOptions({ ...base, seed: 1.5 }), /--seed/)
  assert.throws(() => checkOptions({ ...base, cpuThrottle: 0.5 }), /--cpu-throttle/)
  // The page's clocks start at constants, never at the real time of the capture.
  assert.equal(o.timeOrigin, 0)
  assert.equal(o.clockDate, '2000-01-01T00:00:00.000Z')
  assert.equal(o.epoch, Date.UTC(2000, 0, 1))
  assert.equal(o.timezone, 'UTC')
  const moved = checkOptions({ ...base, clockDate: '2026-11-04T19:00+07:00', timeOrigin: 250 })
  assert.equal(moved.clockDate, '2026-11-04T12:00:00.000Z')
  assert.equal(moved.timeOrigin, 250)
  assert.throws(() => checkOptions({ ...base, timeOrigin: -1 }), /--time-origin -1/)
  assert.throws(() => checkOptions({ ...base, timeOrigin: 0.5 }), /--time-origin 0.5/)
  assert.throws(() => checkOptions({ ...base, clockDate: '2026-11-04' }), /--clock-date.*offset/)
  assert.throws(() => checkOptions({ ...base, clockDate: '2026-13-40T00:00Z' }), /--clock-date/)
  assert.throws(() => checkOptions({ ...base, timezone: 'Mars/Olympus' }), /--timezone Mars/)
  assert.equal(await pageUrl('https://example.com/a?b'), 'https://example.com/a?b')
  await assert.rejects(pageUrl('ftp://example.com/'), /http, https or file/)
  await assert.rejects(pageUrl('no/such/page.html'), /neither a URL nor a file/)
  assert.match(
    await pageUrl(join(import.meta.dirname, 'web-capture', 'linear.html')),
    /^file:\/\/.*linear\.html$/,
  )
})

test('each trigger takes its own settings and refuses the others', () => {
  const base = {
    page: 'https://example.com/',
    out: 'references/hero',
    track: ['.hero h1'],
    fps: 30,
    duration: 2,
    viewport: { width: 1280, height: 720 },
  }
  const o = checkOptions(base)
  assert.deepEqual(o.trigger, { type: 'load' }, 'the motion starts with the page by default')
  assert.equal(o.settle, 'load')
  assert.deepEqual(checkOptions({ ...base, trigger: 'none' }).trigger, { type: 'none' })
  assert.equal(checkOptions({ ...base, settle: 'loaded' }).settle, 'loaded')
  assert.deepEqual(checkOptions({ ...base, trigger: 'click', target: '#b', at: 500 }).trigger, {
    type: 'click',
    target: '#b',
    at: 500,
  })
  assert.deepEqual(
    checkOptions({ ...base, trigger: 'scroll', at: 0, scrollTo: 600, scrollMs: 300 }).trigger,
    { type: 'scroll', at: 0, scrollTo: 600, scrollMs: 300 },
  )
  const refuses = (more: Record<string, unknown>, message: RegExp) =>
    assert.throws(() => checkOptions({ ...base, ...more }), message)
  refuses({ settle: 'idle' }, /--settle idle is not one of load, loaded/)
  refuses({ trigger: 'tap' }, /--trigger tap is not one of load, none, click/)
  refuses({ target: '#b' }, /--target is not for --trigger load: it sends no input/)
  refuses({ trigger: 'none', at: 10 }, /--at is not for --trigger none/)
  refuses({ trigger: 'click', at: 500 }, /--trigger click needs --target/)
  refuses({ trigger: 'hover', target: '#b' }, /--trigger hover needs --at <ms>/)
  refuses({ trigger: 'click', target: ' ', at: 0 }, /--target is empty/)
  refuses({ trigger: 'click', target: '#b', at: 2001 }, /--at 2001 is not ms from 0 to .* 2000/)
  // 0.52 s at 30 fps: the last frame is at 500 ms, so a click at 510 would show on no frame.
  refuses(
    { trigger: 'click', target: '#b', at: 510, duration: 0.52 },
    /--at 510 is not ms from 0 to the last frame, at 500 ms/,
  )
  refuses(
    { trigger: 'scroll', at: 400, scrollTo: 10, scrollMs: 110, duration: 0.52 },
    /end the scroll at 510 ms, after the last frame, at 500 ms/,
  )
  refuses({ trigger: 'click', target: '#b', at: -1 }, /--at -1/)
  refuses({ trigger: 'leave', target: '#b', at: 0 }, /--at 0 with --trigger leave/)
  refuses(
    { trigger: 'click', target: '#b', at: 0, scrollTo: 10 },
    /--scroll-to is not for --trigger click: it takes --target, --at/,
  )
  refuses(
    { trigger: 'scroll', at: 0, scrollTo: 10 },
    /--trigger scroll needs --scroll-to.*--scroll-ms/,
  )
  refuses({ trigger: 'scroll', at: 0, scrollTo: 10.5, scrollMs: 0 }, /--scroll-to 10.5/)
  refuses({ trigger: 'scroll', at: 0, scrollTo: 10, scrollMs: -1 }, /--scroll-ms -1/)
  refuses(
    { trigger: 'scroll', at: 1900, scrollTo: 10, scrollMs: 200 },
    /end the scroll at 2100 ms, after the last frame, at 2000 ms/,
  )
  refuses({ track: ['window'] }, /--track window: that name holds the window's own scrollX/)
})

test('a trigger sends its inputs at their times, and a scroll adds up to its distance', () => {
  assert.deepEqual(inputsOf({ type: 'load' }, 30), [])
  assert.deepEqual(inputsOf({ type: 'click', target: '#b', at: 500 }, 30), [
    { ms: 500, kind: 'click' },
  ])
  assert.deepEqual(inputsOf({ type: 'leave', target: '#b', at: 800 }, 30), [
    { ms: 0, kind: 'hover' },
    { ms: 800, kind: 'leave' },
  ])
  assert.deepEqual(inputsOf({ type: 'scroll', at: 100, scrollTo: 50, scrollMs: 0 }, 30), [
    { ms: 100, kind: 'scroll-start' },
    { ms: 100, kind: 'wheel', step: 1, of: 1 },
  ])
  // 100 ms at rafHz 60: one wheel event each 1/60 s, the last at the end.
  const wheels = inputsOf({ type: 'scroll', at: 200, scrollTo: 600, scrollMs: 100 }, 60).slice(1)
  assert.equal(wheels.length, 6)
  assert.ok(Math.abs((wheels[0]?.ms as number) - (200 + 100 / 6)) < 1e-9)
  assert.equal(wheels.at(-1)?.ms, 300)
  for (const [distance, of] of [
    [600, 9],
    [-250, 7],
    [1, 6],
    [0, 3],
  ] as const) {
    const deltas = Array.from({ length: of }, (_, i) => wheelDelta(distance, i + 1, of))
    assert.equal(
      deltas.reduce((a, b) => a + b, 0),
      distance,
    )
    assert.ok(deltas.every((d) => Number.isInteger(d)))
  }
  assert.deepEqual(
    Array.from({ length: 9 }, (_, i) => wheelDelta(600, i + 1, 9)),
    [67, 66, 67, 67, 66, 67, 67, 66, 67],
  )
})

test('a transform matrix comes apart into channels that build it back', () => {
  const rad = Math.PI / 180
  const build = (t: ReturnType<typeof decompose>) => {
    // translate(tx, ty) rotate(r) skewX(k) scale(sx, sy)
    const c = Math.cos(t.rotate * rad)
    const s = Math.sin(t.rotate * rad)
    const k = Math.tan(t.skewX * rad)
    return [
      c * t.scaleX,
      s * t.scaleX,
      (c * k - s) * t.scaleY,
      (s * k + c) * t.scaleY,
      t.translateX,
      t.translateY,
    ]
  }
  const cases = [
    [1, 0, 0, 1, 0, 0],
    [1, 0, 0, 1, 120, -40],
    [0, 1, -1, 0, 5, 6],
    [2, 0, 0, 0.5, 0, 0],
    [1, 0, 0.5, 1, 0, 0],
    [-1, 0, 0, 1, 0, 0],
    [0.3, -1.2, 0.8, 0.4, 9, 9],
  ]
  for (const m of cases) {
    const back = build(decompose(m))
    for (const [i, v] of back.entries())
      assert.ok(Math.abs(v - (m[i] as number)) < 1e-9, `${m}: ${back}`)
  }
  // As the writer keeps them, to 1/10000 of a unit.
  const kept = Object.fromEntries(
    Object.entries(decompose([0, 1, -1, 0, 5, 6])).map(([k, v]) => [
      k,
      Math.round(v * 1e4) / 1e4 || 0,
    ]),
  )
  assert.deepEqual(kept, {
    translateX: 5,
    translateY: 6,
    rotate: 90,
    skewX: 0,
    scaleX: 1,
    scaleY: 1,
  })
  // A turn past 180 degrees keeps counting.
  assert.equal(unwrap(-170, 175), 190)
  assert.equal(unwrap(170, -175), -190)
  assert.equal(unwrap(10, null), 10)
  assert.equal(unwrap(-350, 0), 10)
})

test('an input is sent with the first frame not before it, and never after that frame', () => {
  // At 24 fps a wheel's time rounds a hair past a frame's (208.33333333333334 against
  // 208.33333333333331): it goes with that frame, sent at the frame's time, so the clock never
  // goes back.
  const scroll = inputsOf({ type: 'scroll', at: 0, scrollTo: 240, scrollMs: 500 }, 24)
  const fps = 24
  const frames = Math.floor(0.6 * fps + 1e-9) + 1
  const batches = batchesOf(scroll, frames, fps)
  assert.equal(batches.flat().length, scroll.length, 'every input has a frame')
  let clock = 0
  batches.forEach((batch, k) => {
    for (const { input, ms } of batch) {
      assert.ok(ms >= clock && ms <= frameMs(k, fps), `input at ${input.ms} sent by frame ${k}`)
      assert.ok(Math.abs(ms - input.ms) < 1e-6)
      clock = ms
    }
    clock = frameMs(k, fps)
  })
  assert.ok(scroll.some((i) => i.ms > frameMs(Math.round((i.ms * fps) / 1000), fps)))
  // A click at a whole ms that rounds the same way at 24 fps.
  const click = inputsOf({ type: 'click', target: '#b', at: 8125 }, 24)
  const k = Math.round((8125 * fps) / 1000)
  const sent = batchesOf(click, k + 1, fps)
  assert.deepEqual(
    sent[k]?.map((b) => b.ms),
    [frameMs(k, fps)],
  )
  assert.throws(() => batchesOf(click, k, fps), /an input at 8125 ms is after the last frame/)
})

test('a still takes its own settings, on an animation frame, and refuses motion ones', () => {
  const base = {
    page: 'https://example.com/',
    out: 'references/hero',
    still: 500,
    rafHz: 60,
    viewport: { width: 1280, height: 720 },
  }
  const o = checkOptions(base)
  assert.equal(o.mode, 'still')
  assert.deepEqual(o.times, [500])
  assert.equal(o.root, ':root', 'the whole page when no root is given')
  assert.deepEqual(o.styles, STYLES)
  assert.deepEqual(checkOptions({ ...base, styles: ['text-align'] }).styles, [
    ...STYLES,
    'text-align',
  ])
  assert.equal(checkOptions({ ...base, still: 0, rafHz: 24 }).still, 0)
  assert.equal(checkOptions({ ...base, still: 125, rafHz: 24 }).still, 125)
  const refuses = (more: Record<string, unknown>, message: RegExp) =>
    assert.throws(() => checkOptions({ ...base, ...more }), message)
  refuses({ rafHz: undefined }, /--still needs --rafHz/)
  refuses(
    { still: 510 },
    /--still 510 is not on an animation frame at --rafHz 60 \(one each 16\.667 ms\).*Give 500 or 516\.667/,
  )
  refuses({ still: -1 }, /--still -1 is not ms of 0 or more/)
  refuses({ track: ['#a'] }, /--track is for motion/)
  refuses({ fps: 30 }, /--fps is for motion/)
  refuses({ duration: 1 }, /--duration is for motion/)
  refuses({ root: ' ' }, /--root is empty/)
  refuses({ styles: ['color'] }, /--style color is read already/)
  refuses({ styles: ['text-align', 'text-align'] }, /--style text-align is given twice/)
  refuses({ styles: ['--accent'] }, /--style --accent is a custom property/)
  refuses({ styles: ['Text Align'] }, /is not a CSS property name/)
  // An input is sent up to the still, and not after it.
  assert.deepEqual(checkOptions({ ...base, trigger: 'hover', target: '#b', at: 500 }).trigger, {
    type: 'hover',
    target: '#b',
    at: 500,
  })
  refuses(
    { trigger: 'hover', target: '#b', at: 501 },
    /--at 501 is not ms from 0 to the still, at 500 ms/,
  )
  // And a motion capture refuses the still's.
  const motion = { ...base, still: undefined, track: ['#a'], fps: 30, duration: 1 }
  assert.throws(() => checkOptions({ ...motion, root: 'main' }), /--root is for --still/)
  assert.throws(() => checkOptions({ ...motion, styles: ['x'] }), /--style is for --still/)
  assert.throws(() => checkOptions({ ...motion, track: [] }), /--track <selector>.*or --still <ms>/)
})

/** A PNG header for a width and a height: what pngSize and the reader look at. */
const pngOf = (width: number, height: number) => {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const v = new DataView(b.buffer)
  v.setUint32(16, width)
  v.setUint32(20, height)
  return b
}
const sha = async (b: Uint8Array) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', b)).toString('hex')

const styleDoc = async (png: Uint8Array): Promise<StyleDoc> => ({
  format: 'shaderera.analysis/1',
  kind: 'reference-style',
  source: {
    url: 'https://example.com/',
    date: '2026-11-04T00:00:00.000Z',
    viewport: { width: 800, height: 400 },
    devicePixelRatio: 1,
    responses: [
      { url: 'https://example.com/z.css', status: 200, sha256: 'b'.repeat(64) },
      { url: 'https://example.com/', status: 200, sha256: 'a'.repeat(64) },
    ],
  },
  tool: { version: '0.3.0', script: 'tools/capture-web.ts' },
  params: { still: 500, styles: ['font-size', 'color'], rafHz: 60 },
  frame: { width: 800, height: 400, pixelRatio: 1 },
  scroll: { x: 0, y: 0 },
  screenshot: { path: 'style.png', width: 800, height: 400, sha256: await sha(png) },
  elements: [
    {
      styles: { 'font-size': '40px', color: 'rgb(20, 30, 40)' },
      tag: 'h1',
      element: '[data-id="card"] > h1',
      box: [64, 84.0000001, 272, 48],
      paintOrder: 2,
    },
    {
      element: '[data-id="card"]',
      pseudoElement: '::after',
      tag: 'div',
      dataId: 'card',
      box: [40, 256, 320, 4],
      paintOrder: 3,
      styles: { 'font-size': '16px', color: 'rgb(0, 0, 0)' },
    },
  ],
  texts: [
    {
      element: '[data-id="card"] > h1',
      child: 0,
      text: 'Hello',
      boxes: [{ start: 0, length: 5, box: [64, 82, 91.703125, 52] }],
      fonts: [
        { familyName: 'Thonburi', postScriptName: 'Thonburi', isCustomFont: false, glyphCount: 4 },
        {
          glyphCount: 5,
          familyName: 'IBM Plex Sans',
          postScriptName: 'IBMPlexSans',
          isCustomFont: true,
        },
      ],
    },
  ],
  fontFaces: [{ src: 'https://example.com/plex.ttf', fontFamily: 'Plex' }],
  limits: [],
})

test('a reference-style artifact is written in one order and read back', async () => {
  const png = pngOf(800, 400)
  assert.deepEqual(pngSize(png), { width: 800, height: 400 })
  assert.throws(() => pngSize(new Uint8Array(40)), /not a PNG/)
  const json = styleJson(await styleDoc(png))
  assert.equal(styleJson(JSON.parse(json)), json, 'what it writes it writes again the same')
  // One element per line, its keys in one order, its styles in params.styles' order.
  assert.equal(
    json.split('\n').find((l) => l.includes('"tag":"h1"')),
    '    {"element":"[data-id=\\"card\\"] > h1","tag":"h1","box":[64,84,272,48],"paintOrder":2,"styles":{"font-size":"40px","color":"rgb(20, 30, 40)"}},',
  )
  assert.match(
    json,
    /"element":"\[data-id=\\"card\\"\]","dataId":"card","tag":"div","pseudoElement":"::after"/,
  )
  // A text's fonts sorted by family; responses by url.
  const parsed = JSON.parse(json)
  assert.deepEqual(
    parsed.texts[0].fonts.map((f: { familyName: string }) => f.familyName),
    ['IBM Plex Sans', 'Thonburi'],
  )
  assert.deepEqual(Object.keys(parsed.texts[0].boxes[0]), ['box', 'start', 'length'])
  assert.deepEqual(
    parsed.source.responses.map((r: { url: string }) => r.url),
    ['https://example.com/', 'https://example.com/z.css'],
  )
  assert.deepEqual(Object.keys(parsed), [
    'format',
    'kind',
    'source',
    'tool',
    'params',
    'frame',
    'scroll',
    'screenshot',
    'elements',
    'texts',
    'fontFaces',
    'limits',
  ])

  const files = new Map([
    ['references/hero/style.json', new TextEncoder().encode(json)],
    ['references/hero/style.png', png],
  ])
  const host = {
    io: {
      read: async (p: string) => {
        const b = files.get(p)
        if (!b) throw new Error(`No file ${p}`)
        return b
      },
    },
  } as unknown as import('@shaderera/core').Host
  const style = await loadStyle(host, 'references/hero/style.json')
  assert.equal(styleOf(style, '[data-id="card"]', '::after').box[1], 256)
  assert.equal(textsOf(style, '[data-id="card"] > h1')[0]?.text, 'Hello')
  assert.deepEqual(textsOf(style, '[data-id="card"]'), [])
  assert.throws(
    () => styleOf(style, '#nothing'),
    /has no element #nothing: it has \[data-id="card"\] > h1, \[data-id="card"\]::after/,
  )
  // A reference-tracks reader refuses it, and names this reader.
  await assert.rejects(
    loadTracks(host, 'references/hero/style.json'),
    /not reference-tracks: read it with loadStyle, from analysis-web-capture/,
  )
  // A screenshot that is not the one captured is refused.
  files.set('references/hero/style.png', pngOf(800, 401))
  await assert.rejects(
    loadStyle(host, 'references/hero/style.json'),
    /references\/hero\/style\.png is not the screenshot/,
  )
})

test('the reference-style writer refuses what its reader would', async () => {
  const doc = await styleDoc(pngOf(800, 400))
  const refuses = (more: Record<string, unknown>, message: RegExp) =>
    assert.throws(() => styleJson({ ...doc, ...more } as StyleDoc), message)
  refuses({ kind: 'reference-tracks' }, /not reference-style: read it with loadTracks/)
  refuses({ extra: 1 }, /reference-style has no field extra/)
  refuses({ scroll: { x: 0 } }, /needs scroll \{ x, y \}/)
  refuses(
    { screenshot: { ...doc.screenshot, path: '../style.png' } },
    /screenshot \.\.\/style\.png is not a file beside it/,
  )
  refuses(
    { elements: [{ ...doc.elements[0], box: [0, 0, -1, 4] }] },
    /element 0 .* needs a box \[x, y, width, height\]/,
  )
  refuses(
    { elements: [{ ...doc.elements[0], styles: { color: 1 } }] },
    /styles are not names to computed values/,
  )
  refuses(
    { texts: [{ ...doc.texts[0], fonts: [{ familyName: 'A' }] }] },
    /fonts need a familyName, postScriptName, isCustomFont and glyphCount/,
  )
  refuses({ source: { ...doc.source, date: 'today' } }, /not ISO 8601 in UTC/)
})
