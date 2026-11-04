// analysis-web-capture, without Chrome: copied into a project the way `add` lays it out. The
// address check refuses loopback, private, link-local and cloud metadata addresses (IPv4, IPv6,
// IPv4 inside IPv6) and a name that resolves to one; the proxy Chrome goes out through refuses
// such a request before it connects, and lets it through with allowLocal. Bad options are
// refused before anything starts, each trigger takes only its own settings and sends its inputs
// at their times, and a transform matrix comes apart into channels that build it back. The
// captures themselves are in analysis-web-capture.it.ts.

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
const { checkOptions, decompose, inputsOf, pageUrl, unwrap, wheelDelta } = (await from(
  'tools/capture-web.ts',
)) as typeof import('../analysis-web-capture/tools/capture-web.ts')

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
    /end the scroll at 2100 ms, after the capture's 2000/,
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
