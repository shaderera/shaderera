// Every item renders, headless: the way a Node host opens a project (WebGPU from `webgpu`,
// canvases and fonts from @napi-rs/canvas). Pixels are checked for what each item must draw.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Canvas, GlobalFonts } from '@napi-rs/canvas'
import type { Host } from '@shaderera/core'
import { create, globals } from 'webgpu'
import { project } from './assemble.ts'

const from = (p: string) => import(pathToFileURL(join(project, p)).href)
const { createCodeWall, readCode } = (await from(
  'src/type/code-wall.ts',
)) as typeof import('../text-code-wall/src/type/code-wall.ts')
const { createCaptions } = (await from(
  'src/type/captions.ts',
)) as typeof import('../text-feature-captions/src/type/captions.ts')
const { glyphPoints } = (await from(
  'src/procedural/glyph-points.ts',
)) as typeof import('../text-glyph-points/src/procedural/glyph-points.ts')
const { decoded, fitWidth, glitched, scramble } = (await from(
  'src/type/kinetic.ts',
)) as typeof import('../text-kinetic/src/type/kinetic.ts')
const { bandsOf, clockFromAnalysis, clockOf, fitGrid, pulse } = (await from(
  'src/music/beat.ts',
)) as typeof import('../audio-beat-clock/src/music/beat.ts')
const { freeCorner, safeArea, widenFov } = (await from(
  'src/layout/frame.ts',
)) as typeof import('../format-safe-areas/src/layout/frame.ts')
const { bezier, glide, hold, path3, progress, settle, track, track3 } = (await from(
  'src/motion/keyframes.ts',
)) as typeof import('../motion-keyframes/src/motion/keyframes.ts')
const { cameraCapability, cameraPath, cameraTrack, fit, lens, shot, viewProjection } = (await from(
  'src/motion/camera.ts',
)) as typeof import('../camera-keyframes/src/motion/camera.ts')
const { hits, SHAKE, shake } = (await from(
  'src/motion/shake.ts',
)) as typeof import('../camera-shake/src/motion/shake.ts')
const { createThreeHost, threeCamera } = (await from(
  'src/three/host.ts',
)) as typeof import('../render-three-host/src/three/host.ts')
const { decodeImage, loadAtlas, loadTexture } = (await from(
  'src/three/images.ts',
)) as typeof import('../render-image-textures/src/three/images.ts')
type Analysis = import('../audio-beat-clock/src/music/beat.ts').Analysis

Object.assign(globalThis, globals)
const here = join(import.meta.dirname, '..')
GlobalFonts.registerFromPath(
  join(here, 'font-ibm-plex-mono', 'assets', 'fonts', 'IBMPlexMono-SemiBold.ttf'),
  'Plex Bold',
)
GlobalFonts.registerFromPath(
  join(here, 'font-ibm-plex-mono', 'assets', 'fonts', 'IBMPlexMono-Regular.ttf'),
  'Plex',
)
GlobalFonts.registerFromPath(
  join(here, 'font-stix-two-text', 'assets', 'fonts', 'STIXTwoText-Italic[wght].ttf'),
  'Stix Italic',
)

const io = {
  read: async (p: string) => new Uint8Array(readFileSync(join(project, p))),
  canvas: (w: number, h: number) => new Canvas(w, h) as unknown as OffscreenCanvas,
  font: async () => {},
}
const hostOf = (width: number, height: number, gpu?: GPUDevice): Host =>
  ({
    manifest: { entry: '', width, height, fps: 60, duration: 4 },
    params: {},
    seed: 1,
    io,
    gpu,
  }) as unknown as Host

const inked = (c: OffscreenCanvas) => {
  const d = (c.getContext('2d') as OffscreenCanvasRenderingContext2D).getImageData(
    0,
    0,
    c.width,
    c.height,
  ).data
  let n = 0
  for (let i = 3; i < d.length; i += 4) if ((d[i] ?? 0) > 0) n++
  return n / (c.width * c.height)
}

test('audio-beat-clock: bars, positions, bands and pulses', () => {
  const c = clockOf({ bpm: 120, first: 0.5 })
  assert.equal(c.at(1), 0.5)
  assert.equal(c.at(3, 2, 1), 0.5 + 2 * 2 + 2 * 0.5 + 0.125)
  assert.deepEqual(c.position(c.at(5, 3, 2)), { bar: 5, beat: 4, sixteenth: 3 })
  assert.equal(c.sixteenthAt(0.5 + 0.125 * 9 + 0.01), 9)
  const a = {
    tempo: { bpm: 120, period: 0.5, phase: 0.1, downbeatClass: 0 },
    downbeats: [0.6, 2.6],
    bands: { fps: 60, sub: [0, -20, -40], low: [0, 0, 0], mid: [0, 0, 0], high: [0, 0, 0] },
  } as unknown as Analysis
  assert.ok(Math.abs(clockFromAnalysis(a, { trim: 0.1, firstBar: 2 }).at(2) - 0.5) < 1e-9)
  assert.deepEqual(bandsOf(a)(1 / 60), [0.5, 1, 1, 1])
  assert.equal(pulse(1, [0.5, 2], 0.1), Math.exp(-5))
  assert.equal(pulse(0.2, [0.5]), 0)
})

test('audio-beat-clock: the grid is fitted to the onsets, on the steps they sit on', () => {
  // A 150 BPM song whose hits fall on sixteenths, measured by autocorrelation as 149.85.
  const truth = 60 / 150
  const onsets = Array.from({ length: 400 }, (_, i) => ({
    t: 0.1 + i * (truth / 4) + (((i * 7919) % 11) - 5) * 0.0002,
    strength: i % 4 === 0 ? 400 : 200,
  }))
  const fit = fitGrid(onsets, { period: 60 / 149.85, phase: 0.1 })
  assert.equal(fit.subdivision, 4)
  assert.ok(Math.abs(60 / fit.period - 150) < 0.01, `fitted ${60 / fit.period} BPM`)
  assert.ok(Math.abs(fit.phase - 0.1) < 0.002)
  assert.ok(fit.residualMs < 1.5)
  // Hits only on beats: the beat grid itself.
  const beats = Array.from({ length: 100 }, (_, i) => ({ t: 0.3 + i * 0.5, strength: 300 }))
  const onBeats = fitGrid(beats, { period: 0.5004, phase: 0.3 })
  assert.ok(Math.abs(onBeats.period - 0.5) < 1e-6)
  // Too few onsets: the grid as it came.
  assert.deepEqual(
    {
      ...fitGrid(beats.slice(0, 3), { period: 0.5004, phase: 0.3 }, { subdivision: 1 }),
      residualMs: 0,
    },
    { period: 0.5004, phase: 0.3, subdivision: 1, onsets: 3, residualMs: 0 },
  )
})

test('text-kinetic: deterministic scramble, decode in and out, glitch draws', () => {
  assert.equal(scramble('HELLO WORLD', 7, 0.5), scramble('HELLO WORLD', 7, 0.5))
  assert.notEqual(scramble('HELLO WORLD', 7, 1), 'HELLO WORLD')
  assert.equal(decoded('BEAT', 1.5, { from: 1, to: 3, frame: 9 }).text, 'BEAT')
  assert.ok(decoded('BEAT', 1.5, { from: 1, to: 3, frame: 9 }).settled)
  assert.equal(decoded('BEAT', 0.5, { from: 1, to: 3, frame: 9 }).visible, false)
  const c = io.canvas(640, 360)
  const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
  // `font` is a family alone, as the README says: the functions put the size in front, and a
  // weight there ('600 "Plex Bold"' → '100px 600 "Plex Bold"') is not a CSS font, so the canvas
  // would fall back to another face. A monospace measures every letter the same.
  const font = '"Plex Bold"'
  assert.equal(fitWidth(ctx, font, 'iiii', 400), fitWidth(ctx, font, 'MMMM', 400))
  const size = fitWidth(ctx, font, 'GLITCH', 400)
  ctx.font = `${size}px ${font}`
  assert.ok(Math.abs(ctx.measureText('GLITCH').width - 400) < 0.5)
  ctx.fillStyle = '#fff'
  glitched(ctx, 'GLITCH', 320, 180, { font, size, frame: 3, align: 'center' })
  assert.ok(inked(c) > 0.05, 'glitched text drew')
})

test('format-safe-areas: title-safe margins, platform zones, the tall lens', () => {
  const tall = safeArea(1080, 1920)
  assert.equal(tall.top, 0.14 * 1920)
  const reels = safeArea(1080, 1920, 'reels')
  assert.deepEqual(
    [reels.top, reels.bottom, reels.left, reels.right].map((x) => Math.round(x)),
    [269, 672, 65, 65],
  )
  assert.ok(safeArea(1080, 1920, 'tiktok').right > tall.right)
  assert.equal(safeArea(1920, 1080).left, 96)
  assert.equal(widenFov(0.5, 16 / 9), 0.5)
  const opened = widenFov(0.5, 9 / 16)
  assert.ok(opened > 0.5 && opened < widenFov(0.5, 9 / 16, 1))
})

test('format-safe-areas: the corner farthest from the subject, inside the safe area', () => {
  const corner = (s: [number, number] | [number, number, number, number]) =>
    freeCorner(s, 1920, 1080).corner
  assert.equal(corner([1800, 100]), 'bl')
  assert.equal(corner([100, 100]), 'br')
  assert.equal(corner([100, 1000]), 'tr')
  assert.equal(corner([1800, 1000]), 'tl')
  assert.equal(corner([600, 200, 800, 400]), 'bl', 'a box counts by its centre')
  assert.equal(corner([960, 540]), 'bl', 'a tie goes to bl')
  const a = safeArea(1080, 1920, 'reels')
  assert.deepEqual(freeCorner([100, 1800], 1080, 1920, 'reels'), {
    corner: 'tr',
    x: a.x + a.width,
    y: a.top,
    align: 'right',
    baseline: 'top',
  })
  assert.deepEqual(freeCorner([1000, 100], 1080, 1920, 'reels'), {
    corner: 'bl',
    x: a.left,
    y: 1920 - a.bottom,
    align: 'left',
    baseline: 'bottom',
  })
})

test('text-feature-captions and text-code-wall draw in 16:9 and 9:16', async () => {
  const fonts = { title: '"Plex Bold"', small: '"Plex"', note: '"Stix Italic"' }
  const captions = createCaptions({
    captions: [
      {
        from: 0,
        to: 4,
        items: [
          ['AUDIO DRIVEN', 'the line is the song'],
          ['BEAT GRID', 'cut on the 1/16'],
          ['NO ASSETS', 'all code'],
        ],
      },
    ],
    fonts,
    swap: 1,
  })
  const wall = createCodeWall({
    files: await readCode(hostOf(1, 1), ['src/type/code-wall.ts', 'src/type/kinetic.ts']),
    from: 0,
    to: 4,
    step: 0.125,
    claim: ['EVERYTHING', 'IS SOURCE CODE'],
    fonts: { mono: '"Plex"', claim: '"Plex Bold"' },
  })
  for (const [W, H] of [
    [1920, 1080],
    [1080, 1920],
  ] as const)
    for (const t of [0.5, 1.5, 2.5, 3.5]) {
      const c = io.canvas(W, H)
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
      captions(ctx, W, H, t, Math.round(t * 60))
      assert.ok(inked(c) > 0.005, `caption at ${t} in ${W}x${H}`)
      const w = io.canvas(W, H)
      wall(w.getContext('2d') as OffscreenCanvasRenderingContext2D, W, H, t, Math.round(t * 60))
      assert.ok(inked(w) > 0.02, `wall at ${t} in ${W}x${H}`)
    }
})

test('text-glyph-points: fixed points inside the text, character marks in order', () => {
  const a = glyphPoints(hostOf(1, 1), { text: 'SHADERERA', family: 'Plex Bold', count: 4096 })
  const b = glyphPoints(hostOf(1, 1), { text: 'SHADERERA', family: 'Plex Bold', count: 4096 })
  assert.deepEqual(a.points, b.points)
  for (let i = 0; i < a.points.length; i += 2) assert.ok(Math.abs(a.points[i] ?? 9) <= 0.5)
  assert.equal(a.marks.length, 9)
  assert.ok(a.marks.every((m, i) => i === 0 || m > (a.marks[i - 1] ?? 0)))
  assert.ok(a.aspect > 3)
})

test('motion-keyframes: held, eased, cut', () => {
  const x = track([
    [0, 0],
    [2, 10, glide],
    [3, 20, hold],
  ])
  assert.equal(x(-1), 0)
  assert.equal(x(1), 5)
  assert.equal(x(2.9), 10)
  assert.equal(x(3), 20)
  assert.deepEqual(
    track3([
      [0, [0, 0, 0]],
      [1, [2, 4, 6]],
    ])(0.5),
    [1, 2, 3],
  )
  assert.equal(progress(5, 4, 6), 0.5)
})

test('motion-keyframes: object keys carry an id to inspect and move as tuples do', () => {
  const tuples = track([
    [0, 0],
    [2, 10, glide],
    [3, 20, hold],
  ])
  // A literal with an id, as the stamp builds it: `source` first.
  const k2 = { source: 'src/a.ts:2:5', id: 'k2', at: 2, value: 10, ease: glide }
  const objects = track([{ id: 'k1', at: 0, value: 0 }, k2, [3, 20, hold]])
  for (let t = -1; t <= 4; t += 0.05) assert.equal(objects(t), tuples(t))
  assert.deepEqual(objects.inspect(-1), { id: 'k1', at: 0, index: 0, u: 1 })
  assert.deepEqual(objects.inspect(1), {
    id: 'k2',
    source: 'src/a.ts:2:5',
    at: 2,
    index: 1,
    u: 0.5,
  })
  assert.deepEqual(objects.inspect(2.5), { at: 3, index: 2, u: 0.5 })
  assert.deepEqual(objects.inspect(9), { at: 3, index: 2, u: 1 })
  const p = track3([
    { id: 'a', at: 0, value: [0, 0, 0] },
    { id: 'b', at: 1, value: [2, 4, 6] },
  ])
  assert.deepEqual(p(0.5), [1, 2, 3])
  assert.equal(p.inspect(0.5).id, 'b')
})

test('text-feature-captions: inspect names the caption showing and its item', () => {
  const captions = createCaptions({
    captions: [
      {
        id: 'intro',
        from: 0,
        to: 2,
        items: [
          ['ONE', 'a'],
          ['TWO', 'b'],
        ],
      },
      { from: 2, to: 3, items: [['THREE', 'c']] },
    ],
    fonts: { title: '"Plex Bold"', small: '"Plex"', note: '"Stix Italic"' },
    swap: 1,
    layouts: ['edge', 'split'],
  })
  assert.deepEqual(captions.inspect(-1), [])
  assert.deepEqual(captions.inspect(1.25), [
    {
      id: 'intro',
      from: 0,
      to: 2,
      item: 1,
      index: 1,
      title: 'TWO',
      note: 'b',
      layout: 'split',
      u: 0.25,
    },
  ])
  assert.deepEqual(captions.inspect(2.5), [
    { from: 2, to: 3, item: 0, index: 2, title: 'THREE', note: 'c', layout: 'edge', u: 0.5 },
  ])
})

test('camera-keyframes: the target lands in the middle, right is right, a tall frame opens the lens, the host can take over', async () => {
  const project = (m: Float32Array, p: readonly [number, number, number]) => {
    const v = [0, 1, 2, 3].map(
      (r) =>
        (m[r] ?? 0) * p[0] + (m[4 + r] ?? 0) * p[1] + (m[8 + r] ?? 0) * p[2] + (m[12 + r] ?? 0),
    )
    const w = v[3] ?? 1
    return [(v[0] ?? 0) / w, (v[1] ?? 0) / w, (v[2] ?? 0) / w]
  }
  const camera = cameraTrack([
    [0, shot([0, 0, 10], [0, 0, 0], 40)],
    [4, shot([10, 0, 0], [0, 0, 0], 40)],
  ])
  const c = camera(0, 16 / 9)
  const [x, y, z] = project(viewProjection(c, 16 / 9), [0, 0, 0])
  assert.ok(Math.abs(x ?? 1) < 1e-6 && Math.abs(y ?? 1) < 1e-6 && (z ?? -1) > 0 && (z ?? 2) < 1)
  assert.ok((project(viewProjection(c, 16 / 9), [1, 0, 0])[0] ?? 0) > 0, 'world +x is screen right')
  assert.ok((project(viewProjection(c, 16 / 9), [0, 1, 0])[1] ?? 0) > 0, 'world +y is screen up')
  assert.ok(camera(0, 9 / 16).fov > c.fov)
  const down = shot([0, 10, 0.0001], [0, 0, 0], 40)
  assert.ok(viewProjection(down, 1).every(Number.isFinite), 'straight down does not break')
  const cam = cameraCapability(camera, 16 / 9)
  const own = await cam.capability.get(2)
  assert.equal(own.view.length, 16)
  const free = { view: Array(16).fill(0), projection: Array(16).fill(0) }
  cam.capability.override?.(free)
  assert.equal(cam.through(2), free)
  cam.capability.override?.(null)
  assert.deepEqual(cam.through(2), own)
})

test('motion-keyframes: stateless spring, bezier, a path that flows through its points', () => {
  const s = settle(8)
  assert.equal(s(0), 0)
  assert.ok(Math.abs(s(1) - 1) < 1e-9 && s(0.5) > 0.9)
  const ease = bezier(0.25, 0.1, 0.25, 1)
  assert.ok(Math.abs(ease(0.5) - 0.8024) < 0.01)
  const p = path3(
    [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ],
    0,
    2,
    (u) => u,
  )
  assert.ok(Math.abs((p(1)[0] ?? 0) - 1) < 1e-3, 'even speed: halfway in time is halfway along')
  assert.ok((p(1.01)[0] ?? 0) > (p(1)[0] ?? 0), 'it does not stop at the middle point')
})

test('camera-keyframes: orbits keep their distance, fit frames exactly, lenses, paths, shift', () => {
  const camera = cameraTrack([
    [0, shot([0, 0, 10], [0, 0, 0], 40)],
    [2, shot([10, 0, 0], [0, 0, 0], 40)],
    [3, shot([0, 0, 10], [0, 0, 0], 40, 0, { path: 'line' })],
  ])
  const mid = camera(1, 16 / 9).eye
  assert.ok(Math.abs(Math.hypot(...mid) - 10) < 1e-6, 'an orbit keeps its distance')
  assert.ok(Math.hypot(...camera(2.5, 16 / 9).eye) < 9.9, 'a line cuts across')
  assert.ok(Math.abs(lens(35) - 31.4) < 0.5, 'a 35 mm lens on 16:9 is about 31 degrees vertical')
  const f = fit({ center: [0, 0, 0], radius: 1, azimuth: 0, elevation: 0, fov: 40, fill: 0.5 })
  const d = Math.hypot(...f.eye)
  assert.ok(
    Math.abs(Math.asin(1 / d) - (0.5 * (20 * Math.PI)) / 180) < 1e-9,
    'the subject spans half the height',
  )
  const path = cameraPath([shot([0, 0, 10]), shot([5, 0, 5]), shot([10, 0, 0])], 0, 2)
  assert.ok(path(1, 16 / 9).eye[0] > 3 && path(1, 16 / 9).eye[0] < 7)
  const shifted = viewProjection(shot([0, 0, 10], [0, 0, 0], 40, 0, { shift: [-1 / 6, 0] }), 16 / 9)
  const v = [0, 1, 2, 3].map((r) => shifted[12 + r] ?? 0)
  assert.ok(
    Math.abs((v[0] ?? 0) / (v[3] ?? 1) + 1 / 3) < 1e-6,
    'the target moves to the left third',
  )
})

test('camera-shake: the same at any t in any order, still at zero amount, kicks on a hit', () => {
  const c = shot([0, 0, 10], [0, 0, 0], 40)
  const a = shake(c, 3.2, SHAKE.handheld)
  shake(c, 9, SHAKE.handheld)
  assert.deepEqual(shake(c, 3.2, SHAKE.handheld), a)
  assert.deepEqual(shake(c, 3.2, SHAKE.impact, 0), c)
  assert.notDeepEqual(a.target, c.target)
  assert.equal(hits(0.5, [1]), 0)
  assert.equal(hits(1, [1]), 1)
})

test('render-three-host + render-image-textures: an image card renders on the host GPU, the same at any t in any order, texture and bytes alike', async () => {
  const THREE = await import('three/webgpu')
  const gpu = create([])
  const adapter = await gpu.requestAdapter()
  assert.ok(adapter)
  const device = await adapter.requestDevice()
  const errors: string[] = []
  device.addEventListener('uncapturederror', (e) =>
    errors.push((e as GPUUncapturedErrorEvent).error.message),
  )
  // A test "painting": a PNG made here, written where the project reads it.
  const art = io.canvas(64, 48)
  const actx = art.getContext('2d') as OffscreenCanvasRenderingContext2D
  actx.fillStyle = '#c03020'
  actx.fillRect(0, 0, 64, 48)
  actx.fillStyle = '#2050c0'
  actx.fillRect(32, 0, 32, 48)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(project, 'painting.png'), await (art as unknown as Canvas).encode('png'))
  const W = 320
  const H = 180
  const host = hostOf(W, H, device)
  const png = decodeImage(new Uint8Array(readFileSync(join(project, 'painting.png'))))
  assert.deepEqual([png.width, png.height, png.data[0], png.data[2]], [64, 48, 0xc0, 0x20])
  const { texture, aspect } = await loadTexture(host, 'painting.png')
  const atlas = await loadAtlas(host, ['painting.png', 'painting.png'], { cell: 32 })
  assert.equal(atlas.rects.length, 2)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#F7F5F0')
  const card = new THREE.Mesh(
    new THREE.PlaneGeometry(aspect, 1),
    new THREE.MeshBasicNodeMaterial({ map: texture }),
  )
  scene.add(card)
  const camera = threeCamera(W / H, 30)
  camera.position.set(0, 0, 3)
  camera.lookAt(0, 0, 0)
  const row = Math.ceil((W * 4) / 256) * 256
  const buf = device.createBuffer({
    size: row * H,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const read = async (layer: { color: unknown }) => {
    if (layer.color instanceof Uint8Array) return layer.color.slice()
    const e = device.createCommandEncoder()
    e.copyTextureToBuffer(
      { texture: layer.color as GPUTexture },
      { buffer: buf, bytesPerRow: row },
      [W, H],
    )
    device.queue.submit([e.finish()])
    await buf.mapAsync(GPUMapMode.READ)
    const p = new Uint8Array(buf.getMappedRange())
    const out = new Uint8Array(W * H * 4)
    for (let y = 0; y < H; y++) out.set(p.subarray(y * row, y * row + W * 4), y * W * 4)
    buf.unmap()
    return out
  }
  const three = await createThreeHost(host, { toneMapping: THREE.NoToneMapping })
  const at = async (t: number) => {
    card.rotation.y = Math.sin(t) * 0.3
    return read(await three.render(scene, camera, t, { width: W, height: H }))
  }
  const first = await at(1)
  const tex = (await three.render(scene, camera, 1, { width: W, height: H })).color
  assert.ok(!(tex instanceof Uint8Array), 'the frame goes to the host as a GPU texture')
  await at(4)
  assert.deepEqual(await at(1), first, 'the same t gives the same pixels after another t')
  const px = (x: number, y: number) =>
    Array.from(first.subarray((y * W + x) * 4, (y * W + x) * 4 + 4))
  assert.ok((px(5, 5)[0] ?? 0) > 240, 'paper behind the card')
  const left = px(W / 2 - 20, H / 2)
  const right = px(W / 2 + 20, H / 2)
  assert.ok((left[0] ?? 0) > 150 && (left[2] ?? 255) < 80, `the card's red half, ${left}`)
  assert.ok((right[2] ?? 0) > 150 && (right[0] ?? 255) < 80, `the card's blue half, ${right}`)
  const bytesHost = await createThreeHost(host, {
    toneMapping: THREE.NoToneMapping,
    output: 'bytes',
  })
  card.rotation.y = Math.sin(1) * 0.3
  assert.deepEqual(
    await read(await bytesHost.render(scene, camera, 1, { width: W, height: H })),
    first,
  )
  assert.deepEqual(errors, [])
  three.dispose()
  bytesHost.dispose()
})

test('format-placement-specs: every entry names its source and uses only fields deliver checks', () => {
  const specs = JSON.parse(
    readFileSync(join(project, 'delivery', 'placements.json'), 'utf8'),
  ) as Record<string, Record<string, unknown>>
  // apps/cli/src/deliver/placement.ts, Placement.
  const fields = new Set(
    'name source containers videoCodecs width height minWidth minHeight aspect fps minDuration maxDuration durations maxBytes minBitrate maxBitrate audio audioCodecs sampleRates minChannels loudness editList safeArea'.split(
      ' ',
    ),
  )
  assert.ok(Object.keys(specs).length >= 6)
  for (const [name, spec] of Object.entries(specs)) {
    assert.match(String(spec.source), /read 2026-\d\d-\d\d/, `${name} says when it was read`)
    for (const f of Object.keys(spec)) assert.ok(fields.has(f), `${name}: unknown field ${f}`)
  }
  assert.deepEqual(specs['meta-reels-ads']?.safeArea, {
    top: 0.14,
    right: 0.06,
    bottom: 0.35,
    left: 0.06,
  })
})
