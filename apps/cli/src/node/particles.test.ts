import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { exportFrames, frameTimes } from '@shaderera/core'
import { sha256 } from '@shaderera/core/host'
import { buildForNode } from './build.ts'
import { type Child, openChild } from './child.ts'
import { findProject } from './project.ts'

/**
 * The replay check on a real GPU participant (fixtures/particles: WebGPU compute ping-pong,
 * a feedback texture, readback, checkpoints) in the Node host's Dawn. Without a GPU this fails:
 * the fixture refuses to open, and a skipped GPU test is not a pass.
 */
const root = fileURLToPath(new URL('../../fixtures/particles/', import.meta.url))
const project = await findProject(root)
const entryFile = await buildForNode(project)
const fps = project.manifest.fps
const open = (checkpointMs?: number) => openChild(project, { entryFile, checkpointMs })
const hash = async (child: Child, f: number, intent: 'preview' | 'final' = 'final') =>
  sha256((await child.render(f / fps, intent)).pixels)
const ms = (start: number) => Math.round(performance.now() - start)

test('particles: frame N is the same by sequential play, direct, backward, loop, reset and export', async () => {
  const target = 120
  const last = frameTimes(fps, 0, project.manifest.duration).length - 1
  let start = performance.now()
  // Checkpoints every 20 ms of rendering, so the backward seeks restore real GPU state.
  const a = await open(20)
  const coldOpen = ms(start)
  try {
    assert.deepEqual(a.has.sequential, { checkpoint: true })
    start = performance.now()
    let played = ''
    for (let f = 0; f <= target; f++) played = await hash(a, f)
    const sequentialMs = ms(start) / (target + 1)

    start = performance.now()
    await hash(a, last)
    const forward = ms(start)
    start = performance.now()
    const backward = await hash(a, target)
    const backwardMs = ms(start)
    await hash(a, 0)
    const looped = await hash(a, target)
    const seeks = await a.seeks()

    const b = await open()
    start = performance.now()
    const direct = await hash(b, target)
    const directMs = ms(start)
    await b.close()

    // Offline: the export path, frame by frame into a sink, with its own shuffled re-check.
    const c = await open()
    let exported = ''
    let index = 0
    await exportFrames({
      fps,
      from: 0,
      to: (target + 1) / fps,
      render: async (t) => (await c.render(t, 'final')).pixels,
      sink: {
        write: async (pixels) => {
          if (index++ === target) exported = await sha256(pixels)
        },
        end: async () => {},
      },
    })
    await c.close()

    assert.equal(backward, played, 'backward seek')
    assert.equal(looped, played, 'loop back to frame 0 and on')
    assert.equal(direct, played, 'direct seek in a fresh process')
    assert.equal(exported, played, 'export')
    assert.ok((seeks?.restored ?? 0) > 0, 'a backward seek restored a checkpoint')
    console.log(
      JSON.stringify({
        coldOpenMs: coldOpen,
        sequentialMsPerFrame: Math.round(sequentialMs * 10) / 10,
        forwardTo: { frame: last, ms: forward },
        backwardTo: { frame: target, ms: backwardMs },
        directSeekFreshProcess: { frame: target, ms: directMs },
        seeks,
      }),
    )
  } finally {
    await a.close()
  }
})

test('particles: a preview render steps the state exactly as a final one', async () => {
  const a = await open(0)
  const b = await open(0)
  try {
    for (let f = 0; f < 30; f++) await hash(a, f, 'final')
    for (let f = 0; f < 30; f++) await hash(b, f, 'preview')
    assert.equal(await hash(a, 30), await hash(b, 30))
  } finally {
    await a.close()
    await b.close()
  }
})
