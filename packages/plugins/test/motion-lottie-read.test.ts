// motion-lottie-read: copied into a project the way `add` lays it out (with the motion-eases it
// requires, and motion-keyframes for `keysOf`). One small Lottie made here (MIT): its keyframes
// come back exactly as written, `valueAt` matches the bezier formula solved apart from the
// plugin, a curved path is followed by arc length, and what is not read is listed.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const plugins = join(import.meta.dirname, '..')
const project = join(plugins, 'out', 'motion-lottie-read')
rmSync(project, { recursive: true, force: true })
for (const item of ['motion-lottie-read', 'motion-eases', 'motion-keyframes']) {
  const label = JSON.parse(readFileSync(join(plugins, item, 'shaderera.item.json'), 'utf8')) as {
    files: string[]
  }
  for (const f of label.files) {
    mkdirSync(dirname(join(project, f)), { recursive: true })
    cpSync(join(plugins, item, f), join(project, f))
  }
}
const L = (await import(
  pathToFileURL(join(project, 'src/motion/lottie.ts')).href
)) as typeof import('../motion-lottie-read/src/motion/lottie.ts')
const { track } = (await import(
  pathToFileURL(join(project, 'src/motion/keyframes.ts')).href
)) as typeof import('../motion-keyframes/src/motion/keyframes.ts')

const FR = 30
const ease = { o: { x: [0.333], y: [0] }, i: { x: [0.667], y: [1] } }
/** A small animation: a null that moves, turns, scales and fades; a shape layer with extras. */
const fixture = () => ({
  v: '5.12.1',
  nm: 'fixture',
  fr: FR,
  ip: 0,
  op: 90,
  w: 512,
  h: 256,
  ddd: 0,
  layers: [
    {
      ind: 1,
      ty: 3,
      nm: 'Mover',
      ip: 0,
      op: 90,
      st: 0,
      sr: 1,
      ks: {
        a: { a: 0, k: [0, 0, 0] },
        // A curved path: out of the first key up, into the second from below.
        p: {
          a: 1,
          k: [
            { t: 0, s: [100, 200, 0], to: [50, -80, 0], ti: [-40, 60, 0], ...ease },
            { t: 30, s: [400, 120, 0], to: [0, 0, 0], ti: [0, 0, 0], ...ease },
            { t: 60, s: [300, 60, 0] },
          ],
        },
        // Each axis its own curve, y overshooting.
        s: {
          a: 1,
          k: [
            {
              t: 10,
              s: [100, 100, 100],
              o: { x: [0.2, 0.6, 0.4], y: [0, 0.1, 0] },
              i: { x: [0.8, 0.3, 0.6], y: [1, 1.4, 1] },
            },
            { t: 50, s: [150, 50, 100] },
          ],
        },
        r: {
          a: 1,
          k: [
            { t: 0, s: [0], o: { x: 0.42, y: 0 }, i: { x: 0.58, y: 1 } },
            { t: 20, s: [90], h: 1 },
            { t: 40, s: [180], o: { x: 0, y: 0 }, i: { x: 1, y: 1 } },
            { t: 70, s: [-45] },
          ],
        },
        // An older file: each key carries its end value, and the last only its time.
        o: {
          a: 1,
          k: [
            { t: 5, s: [0], e: [100], ...ease },
            { t: 25, s: [100], e: [20], o: { x: [0.1], y: [0.9] }, i: { x: [0.3], y: [1] } },
            { t: 45 },
          ],
        },
      },
    },
    {
      ind: 2,
      ty: 4,
      nm: 'Dot',
      parent: 1,
      ip: 0,
      op: 90,
      st: 0,
      ks: {
        p: {
          s: true,
          x: { a: 0, k: 12 },
          y: {
            a: 1,
            k: [
              { t: 0, s: [0], ...ease },
              { t: 15, s: [40] },
            ],
          },
        },
        o: { a: 0, k: 100, x: 'value * 0.5' },
      },
      masksProperties: [{ mode: 'a' }],
      ef: [{ ty: 5 }],
      shapes: [{ ty: 'el' }],
    },
  ],
})

/** The bezier formula, solved apart from the plugin: x(s) = u by bisection to the last bit. */
const formula = (x1: number, y1: number, x2: number, y2: number, u: number) => {
  const b = (a: number, c: number, s: number) =>
    3 * a * s * (1 - s) ** 2 + 3 * c * s * s * (1 - s) + s ** 3
  let lo = 0
  let hi = 1
  for (let i = 0; i < 200; i++) {
    const s = (lo + hi) / 2
    if (b(x1, x2, s) < u) lo = s
    else hi = s
  }
  return b(y1, y2, (lo + hi) / 2)
}
/** The rotation's key i of the first layer, to break. */
const rKey = (f: ReturnType<typeof fixture>, i: number) =>
  (f.layers[0] as unknown as { ks: { r: { k: Record<string, unknown>[] } } }).ks.r.k[i] as Record<
    string,
    unknown
  >
const near = (a: number, b: number, what: string, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not ${b}`)

test('motion-lottie-read: the file, its layers and its keyframes, as written', () => {
  const lot = L.readLottie(JSON.stringify(fixture()))
  assert.equal(lot.version, '5.12.1')
  assert.deepEqual(
    [lot.fr, lot.ip, lot.op, lot.in, lot.out, lot.width, lot.height],
    [30, 0, 90, 0, 3, 512, 256],
  )
  assert.deepEqual(
    lot.layers.map((l) => [l.index, l.ind, l.name, l.type, l.parent]),
    [
      [0, 1, 'Mover', 'null', undefined],
      [1, 2, 'Dot', 'shape', 1],
    ],
  )
  const ks = lot.layers[0]?.transform ?? {}
  assert.deepEqual(Object.keys(ks), ['a', 'p', 's', 'r', 'o'])
  assert.deepEqual(ks.a?.value, [0, 0, 0])
  assert.equal(ks.a?.animated, false)
  assert.deepEqual(ks.p?.keys, [
    {
      frame: 0,
      t: 0,
      value: [100, 200, 0],
      hold: false,
      out: { x: [0.333], y: [0] },
      in: { x: [0.667], y: [1] },
      pathOut: [50, -80, 0],
      pathIn: [-40, 60, 0],
    },
    {
      frame: 30,
      t: 1,
      value: [400, 120, 0],
      hold: false,
      out: { x: [0.333], y: [0] },
      in: { x: [0.667], y: [1] },
      pathOut: [0, 0, 0],
      pathIn: [0, 0, 0],
    },
    { frame: 60, t: 2, value: [300, 60, 0], hold: false },
  ])
  assert.deepEqual(ks.s?.keys[0]?.out, { x: [0.2, 0.6, 0.4], y: [0, 0.1, 0] })
  assert.deepEqual(ks.s?.keys[0]?.in, { x: [0.8, 0.3, 0.6], y: [1, 1.4, 1] })
  assert.deepEqual(
    ks.r?.keys.map((k) => [k.frame, k.value, k.hold, k.out]),
    [
      [0, [0], false, { x: [0.42], y: [0] }],
      [20, [90], true, undefined],
      [40, [180], false, { x: [0], y: [0] }],
      [70, [-45], false, undefined],
    ],
  )
  assert.deepEqual(
    ks.o?.keys.map((k) => [k.frame, k.value, k.end]),
    [
      [5, [0], [100]],
      [25, [100], [20]],
      [45, undefined, undefined],
    ],
  )
  const dot = lot.layers[1]?.transform ?? {}
  assert.deepEqual(Object.keys(dot), ['px', 'py', 'o'])
  assert.equal(dot.px?.path, 'layers[1].ks.p.x')
  assert.deepEqual(dot.px?.value, [12])
  assert.deepEqual(
    dot.py?.keys.map((k) => k.value),
    [[0], [40]],
  )
  assert.equal(dot.o?.expression, 'value * 0.5')
  // The object reads the same as its text.
  assert.deepEqual(L.readLottie(fixture()), lot)
})

test('motion-lottie-read: valueAt is the bezier formula, per dimension, held and clamped', () => {
  const ks = L.readLottie(fixture()).layers[0]?.transform ?? {}
  const s = ks.s as import('../motion-lottie-read/src/motion/lottie.ts').LottieProperty
  const r = ks.r as import('../motion-lottie-read/src/motion/lottie.ts').LottieProperty
  const o = ks.o as import('../motion-lottie-read/src/motion/lottie.ts').LottieProperty
  for (let f = 10; f <= 50; f += 0.37) {
    const u = (f - 10) / 40
    const v = L.valueAt(s, f / FR)
    near(v[0] as number, 100 + 50 * formula(0.2, 0, 0.8, 1, u), `s.x at ${f}`)
    near(v[1] as number, 100 - 50 * formula(0.6, 0.1, 0.3, 1.4, u), `s.y at ${f}`)
    near(v[2] as number, 100, `s.z at ${f}`)
  }
  // A hard curve, upright at its middle: still the formula.
  const hard = L.readLottie({
    fr: FR,
    ip: 0,
    op: 30,
    w: 1,
    h: 1,
    layers: [
      {
        ty: 3,
        ks: {
          o: {
            a: 1,
            k: [
              { t: 0, s: [0], o: { x: [1], y: [0] }, i: { x: [0], y: [1] } },
              { t: 30, s: [1] },
            ],
          },
        },
      },
    ],
  }).layers[0]?.transform.o as never
  // Off the middle itself, where x is so flat that a float solve of the formula misses by 1e-6;
  // there the curve's symmetry gives the answer.
  for (let i = 0; i < 2000; i++) {
    const u = (i + 0.5) / 2000
    near(L.valueAt(hard, u)[0] as number, formula(1, 0, 0, 1, u), `hard at ${u}`)
  }
  assert.equal(L.valueAt(hard, 0.5)[0], 0.5)
  assert.deepEqual(L.valueAt(s, 0), [100, 100, 100], 'before the first key')
  assert.deepEqual(L.valueAt(s, 3), [150, 50, 100], 'after the last key')
  // y past 1 overshoots the key.
  const ys = Array.from({ length: 41 }, (_, i) => L.valueAt(s, (10 + i) / FR)[1] as number)
  assert.ok(Math.min(...ys) < 50, 'y overshoots its key')
  for (let f = 0; f < 20; f += 0.5)
    near(L.valueAt(r, f / FR)[0] as number, 90 * formula(0.42, 0, 0.58, 1, f / 20), `r at ${f}`)
  for (const f of [20, 25, 39.99]) assert.deepEqual(L.valueAt(r, f / FR), [90], `held at ${f}`)
  near(L.valueAt(r, 55 / FR)[0] as number, 180 - 225 * formula(0, 0, 1, 1, 0.5), 'r at 55')
  assert.deepEqual(L.valueAt(r, 5), [-45])
  // The older file: into `e`, and after its last key the last `e`.
  for (let f = 25; f < 45; f += 0.5)
    near(
      L.valueAt(o, f / FR)[0] as number,
      100 - 80 * formula(0.1, 0.9, 0.3, 1, (f - 25) / 20),
      `o at ${f}`,
    )
  assert.deepEqual(L.valueAt(o, 2), [20])
  assert.deepEqual(L.valueAt(o, 0), [0])
})

test('motion-lottie-read: a curved path is followed by arc length, a straight one evenly', () => {
  const p = L.readLottie(fixture()).layers[0]?.transform
    .p as import('../motion-lottie-read/src/motion/lottie.ts').LottieProperty
  // The cubic and its length, as a polyline of a million pieces.
  const P = [
    [100, 200],
    [150, 120],
    [360, 180],
    [400, 120],
  ]
  const at = (s: number) =>
    [0, 1].map(
      (d) =>
        (1 - s) ** 3 * (P[0]?.[d] as number) +
        3 * (1 - s) ** 2 * s * (P[1]?.[d] as number) +
        3 * (1 - s) * s * s * (P[2]?.[d] as number) +
        s ** 3 * (P[3]?.[d] as number),
    )
  const N = 1_000_000
  const lengths = new Float64Array(N + 1)
  let prev = at(0)
  for (let i = 1; i <= N; i++) {
    const q = at(i / N)
    lengths[i] =
      (lengths[i - 1] as number) +
      Math.hypot((q[0] as number) - (prev[0] as number), (q[1] as number) - (prev[1] as number))
    prev = q
  }
  const total = lengths[N] as number
  for (const f of [3, 7.5, 15, 22, 29]) {
    const want = formula(0.333, 0, 0.667, 1, f / 30) * total
    let i = 0
    while ((lengths[i] as number) < want) i++
    const q = at(i / N)
    const v = L.valueAt(p, f / FR)
    near(v[0] as number, q[0] as number, `p.x at ${f}`, 1e-3)
    near(v[1] as number, q[1] as number, `p.y at ${f}`, 1e-3)
  }
  assert.deepEqual(L.valueAt(p, 1), [400, 120, 0])
  // Zero tangents: a straight move, eased.
  for (const f of [35, 45, 59]) {
    const e = formula(0.333, 0, 0.667, 1, (f - 30) / 30)
    const v = L.valueAt(p, f / FR)
    near(v[0] as number, 400 - 100 * e, `p.x at ${f}`)
    near(v[1] as number, 120 - 60 * e, `p.y at ${f}`)
  }
  // Tangents written as zero with a handle per axis: a player eases the move with the first.
  const flat = fixture()
  const pk = (flat.layers[0] as unknown as { ks: { p: { k: Record<string, unknown>[] } } }).ks.p
    .k[1] as Record<string, unknown>
  pk.o = { x: [0.1, 0.9], y: [0, 0] }
  pk.i = { x: [0.2, 0.8], y: [1, 1] }
  const fp = L.readLottie(flat).layers[0]?.transform.p as never
  for (const f of [35, 45, 59]) {
    const e = formula(0.1, 0, 0.2, 1, (f - 30) / 30)
    const v = L.valueAt(fp, f / FR)
    near(v[0] as number, 400 - 100 * e, `flat p.x at ${f}`)
    near(v[1] as number, 120 - 60 * e, `flat p.y at ${f}`)
  }
})

test('motion-lottie-read: keysOf makes the same curve as a motion-keyframes track, on request', () => {
  const ks = L.readLottie(fixture()).layers[0]?.transform ?? {}
  for (const [name, d] of [
    ['s', 0],
    ['s', 1],
    ['r', 0],
    ['o', 0],
  ] as const) {
    const prop = ks[name] as import('../motion-lottie-read/src/motion/lottie.ts').LottieProperty
    const tr = track(L.keysOf(prop, d))
    for (let f = 0; f <= 90; f += 0.25)
      near(tr(f / FR), L.valueAt(prop, f / FR)[d] as number, `${name}[${d}] at ${f}`)
  }
  assert.throws(() => L.keysOf(ks.p as never, 0), /curved path \(to, ti\): use valueAt/)
  assert.throws(() => (L.keysOf as (p: unknown) => unknown)(ks.p), /keysOf's dimension.*undefined/)
})

test('motion-lottie-read: what is not read is listed, never dropped', () => {
  const lot = L.readLottie(fixture())
  assert.deepEqual(lot.unsupported, [
    { feature: 'shapes', where: 'layers[1].shapes' },
    { feature: 'masks', where: 'layers[1].masksProperties' },
    { feature: 'effects', where: 'layers[1].ef' },
    { feature: 'parenting', where: 'layers[1].parent' },
    { feature: 'expression', where: 'layers[1].ks.o.x' },
  ])
  const more = fixture() as Record<string, unknown> & { layers: Record<string, unknown>[] }
  more.layers.push({
    ty: 0,
    nm: 'Inner',
    refId: 'comp_0',
    ip: 0,
    op: 90,
    st: 10,
    sr: 2,
    tm: { a: 0, k: 0 },
    ks: {},
  })
  more.layers.push({ ty: 7, nm: 'New', ip: 0, op: 90, ks: {} })
  // Switched off, as a boolean or 0, is not listed.
  more.layers.push({ ty: 3, nm: 'Off', ip: 0, op: 90, mb: false, ao: false, bm: 0, ks: {} })
  // An animated orientation is turned as a quaternion by a player: listed, and not played.
  more.layers.push({
    ty: 3,
    nm: 'Turn',
    ddd: 1,
    ip: 0,
    op: 90,
    ks: {
      or: {
        a: 1,
        k: [
          { t: 0, s: [0, 0, 0], ...ease },
          { t: 30, s: [90, 90, 0] },
        ],
      },
    },
  })
  const lot2 = L.readLottie(more)
  assert.deepEqual(lot2.unsupported.slice(5), [
    { feature: 'precomp', where: 'layers[2].refId' },
    { feature: 'time remap', where: 'layers[2].tm' },
    { feature: 'layer type 7', where: 'layers[3].ty' },
    { feature: '3D orientation', where: 'layers[5].ks.or' },
  ])
  const or = lot2.layers[5]?.transform.or as never
  assert.throws(() => L.valueAt(or, 0.5), /layers\[5\]\.ks\.or is an animated 3D orientation/)
  assert.throws(() => L.keysOf(or, 0), /animated 3D orientation/)
  // Markers, collapse transforms, a transform entry with no `k` and any field not known are listed.
  const extra = {
    fr: 30,
    ip: 0,
    op: 60,
    w: 10,
    h: 10,
    markers: [{ tm: 10, cm: 'intro', dr: 20 }],
    future: 1,
    layers: [
      { ty: 3, ip: 0, op: 60, ct: 1, zz: true, ks: { r: { a: 0, k: 5 }, weird: { a: 0, v: 3 } } },
      { ty: 1, ip: 0, op: 60, sc: '#000000', sw: 10, sh: 10, ct: 0, ks: {} },
    ],
  }
  const lot3 = L.readLottie(extra)
  assert.deepEqual(lot3.unsupported, [
    { feature: 'collapse transforms', where: 'layers[0].ct' },
    { feature: 'zz', where: 'layers[0].zz' },
    { feature: 'weird', where: 'layers[0].ks.weird' },
    { feature: 'solid', where: 'layers[1].sc' },
    { feature: 'markers', where: 'markers' },
    { feature: 'future', where: 'future' },
  ])
  assert.deepEqual(Object.keys(lot3.layers[0]?.transform ?? {}), ['r'])
  // A name a file writes is only a name, `__proto__` and `constructor` too.
  const odd = fixture() as Record<string, unknown> & { layers: Record<string, unknown>[] }
  odd.layers.push({ ty: 3, nm: 'Odd', ip: 0, op: 90, ks: {} })
  const json = JSON.stringify(odd).replace(
    '"nm":"Odd","ip":0,"op":90,"ks":{}',
    '"nm":"Odd","ip":0,"op":90,"ks":{"__proto__":{"a":0,"k":5},"constructor":{"a":0,"k":1}}',
  )
  const ks = L.readLottie(json).layers[2]?.transform ?? {}
  assert.deepEqual(Object.keys(ks), ['__proto__', 'constructor'])
  assert.deepEqual(
    Object.values(ks).map((p) => [p.label, p.value]),
    [
      ['__proto__', [5]],
      ['constructor', [1]],
    ],
  )
})

test('motion-lottie-read: refuses what it cannot read as written, by name', async () => {
  assert.throws(() => L.readLottie('PK\u0003\u0004...'), /dotLottie \(\.lottie\) archive: unzip it/)
  assert.throws(() => L.readLottie('{'), /is not JSON/)
  assert.throws(() => L.readLottie({ fr: 30 }), /not a Lottie animation/)
  assert.throws(() => L.readLottie({ ...fixture(), fr: 0 }), /fr is 0/)
  assert.throws(() => L.readLottie({ ...fixture(), op: 0 }), /op is 0, not after ip 0/)
  const back = fixture()
  rKey(back, 1).t = -1
  assert.throws(
    () => L.readLottie(back),
    /layers\[0\]\.ks\.r\.k\[1\]\.t is -1, before the key before it/,
  )
  const bare = fixture()
  delete rKey(bare, 2).o
  assert.throws(
    () => L.readLottie(bare),
    /layers\[0\]\.ks\.r\.k\[2\] moves to the next key with no easing handles/,
  )
  const wide = fixture()
  const handle = rKey(wide, 0).o as { x: number }
  handle.x = 1.5
  assert.throws(() => L.readLottie(wide), /k\[0\]\.o\.x is 1\.5: a handle's x is 0 to 1/)
  const late = fixture()
  ;(late.layers[1] as { ip: number }).ip = 90
  assert.throws(() => L.readLottie(late), /layers\[1\]\.op is 90, not after ip 90/)
  const mixed = fixture()
  ;(rKey(mixed, 1) as { s: number[] }).s = [90, 0]
  assert.throws(
    () => L.readLottie(mixed),
    /layers\[0\]\.ks\.r\.k\[1\]\.s has 2 values, not 1 as the first key has/,
  )
  const seven = fixture()
  ;(seven.layers[0] as unknown as { ks: Record<string, unknown> }).ks.o = 7
  assert.throws(() => L.readLottie(seven), /layers\[0\]\.ks\.o is not a property \(\{a, k\}\)/)
  const r = L.readLottie(fixture()).layers[0]?.transform.r as never
  assert.throws(() => L.valueAt(r, Number.NaN), /valueAt: t is NaN, not a number of seconds/)
  // A byte order mark before the JSON, as some editors save it.
  assert.equal(L.readLottie(`\uFEFF${JSON.stringify(fixture())}`).layers.length, 2)
  const host = { io: { read: async () => new TextEncoder().encode(JSON.stringify(fixture())) } }
  assert.equal((await L.loadLottie(host, 'assets/fixture.json')).layers.length, 2)
})
