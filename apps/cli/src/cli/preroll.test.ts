import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Json, Manifest, Sink } from '@shaderera/core'
import { checkManifest } from '@shaderera/core/host'
import { memoryChild, memoryProject } from '../node/fixtures/memory-child.ts'
import { review } from '../review/review.ts'
import { blackFrame, fileTimecode, prerollOf, writePreroll } from './preroll.ts'

const film = (o: Partial<Manifest>): Manifest => ({
  entry: 'e.ts',
  fps: 25,
  duration: 10,
  width: 8,
  height: 2,
  ...o,
})

test('a preroll is whole frames before the programme; the file timecode counts back from it', () => {
  assert.deepEqual(prerollOf(film({ preroll: { seconds: 10 } })), {
    frames: 250,
    seconds: 10,
    fill: 'black',
  })
  assert.equal(prerollOf(film({})).frames, 0)
  // A 10 s clock before a programme that starts at 10:00:00:00.
  assert.equal(fileTimecode(film({ timecode: '10:00:00:00' }), 0, 250), '09:59:50:00')
  // No programme timecode: it starts at 00:00:00:00, and the preroll wraps back past midnight.
  assert.equal(fileTimecode(film({}), 0, 250), '23:59:50:00')
  const ntsc = film({ fps: 30000 / 1001, timecode: '01:00:00;00' })
  assert.equal(fileTimecode(ntsc, 0, 300), '00:59:50;00')
})

test('black is opaque in every input format, and the source fills a preroll at negative t', async () => {
  assert.deepEqual([...blackFrame('rgba', 1, 1)], [0, 0, 0, 255])
  assert.deepEqual([...new Uint16Array(blackFrame('rgba64', 1, 1).buffer)], [0, 0, 0, 65535])
  assert.deepEqual([...blackFrame('yuv420p', 2, 2)], [16, 16, 16, 16, 128, 128])
  const written: number[] = []
  const sink: Sink = { write: async (p) => void written.push(p[0] as number), end: async () => {} }
  const asked: number[] = []
  await writePreroll(sink, {
    frames: 3,
    fill: 'source',
    from: 0,
    fps: 10,
    black: () => new Uint8Array([0]),
    render: async (t) => {
      asked.push(t)
      return new Uint8Array([asked.length])
    },
  })
  assert.deepEqual(asked, [-0.3, -0.2, -0.1])
  assert.deepEqual(written, [1, 2, 3])
})

test('preroll, timecode and textless are checked in shaderera.json and its variants', () => {
  const good = { entry: 'e.ts', fps: 25, duration: 1, width: 8, height: 8 }
  checkManifest({ ...good, preroll: { seconds: 10, fill: 'source' }, timecode: '10:00:00:00' })
  assert.throws(() => checkManifest({ ...good, preroll: { seconds: 0 } }), /preroll must be/)
  assert.throws(() => checkManifest({ ...good, preroll: { seconds: 1, fill: 'grey' } }), /fill/)
  assert.throws(() => checkManifest({ ...good, timecode: '10:00:00' }), /HH:MM:SS:FF/)
  assert.throws(
    () => checkManifest({ ...good, variants: { clean: { textless: 'yes' } } }),
    /variants\.clean\.textless must be true/,
  )
})

test('a textless variant fails review when text is on screen, and passes without it', async () => {
  const title: Json = { title: { id: 'title', text: 'Spring sale', box: [2, 2, 20, 8] } }
  for (const [state, want] of [
    [title, 'fail'],
    [{}, 'pass'],
  ] as [Json, string][]) {
    const project = memoryProject({ width: 32, height: 16, textless: true })
    const child = memoryChild({ size: { width: 32, height: 16 }, inspect: () => state })
    const r = await review({ project, child, outDir: join(project.root, 'out'), quick: true })
    const c = r.checks.find((x) => x.id === 'textless')
    assert.equal(c?.status, want, JSON.stringify(c))
    if (want === 'fail') assert.deepEqual(c?.where?.[0]?.box, [2, 2, 20, 8])
  }
})
