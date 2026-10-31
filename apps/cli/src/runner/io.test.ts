import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Ask, extraIo } from './io.ts'

test("io.video carries the space a film declares for its footage, and tells the CLI's process whether it did (#575)", async () => {
  const opened: [string, boolean | undefined][] = []
  const ask = {
    videoOpen: async (path: string, declared?: boolean) => {
      opened.push([path, declared])
      const colour = { matrix: 'bt709', range: 'limited', chroma: 'left' } as const
      return { width: 2, height: 2, fps: 10, frames: 1, bits: 10, colour } as const
    },
  } as unknown as Ask
  const io = extraIo(async () => new Uint8Array(), ask)
  const log = await io.video('log.mp4', { transfer: 'slog3', gamut: 'sgamut3cine' })
  assert.deepEqual(log.space, { transfer: 'slog3', gamut: 'sgamut3cine' })
  // Undeclared: no space, as before.
  const plain = await io.video('plain.mp4')
  assert.equal('space' in plain, false)
  // A gamut alone picks no curve: carried, but not declared.
  const wide = await io.video('wide.mp4', { gamut: 'rec2020' })
  assert.deepEqual(wide.space, { gamut: 'rec2020' })
  assert.deepEqual(opened, [
    ['log.mp4', true],
    ['plain.mp4', false],
    ['wide.mp4', false],
  ])
})

test('io.video refuses a transfer or gamut it does not know, naming the ones it does', async () => {
  const ask = { videoOpen: async () => assert.fail('opened') } as unknown as Ask
  const io = extraIo(async () => new Uint8Array(), ask)
  const video = io.video as (path: string, space: object) => Promise<unknown>
  await assert.rejects(
    video('a.mp4', { transfer: 'slog-3' }),
    /io\.video\(a\.mp4\): transfer is one of 'bt709', 'srgb', .*'clog3', not 'slog-3'\./,
  )
  await assert.rejects(
    video('a.mp4', { transfer: 'slog3', gamut: 'sgamut' }),
    /io\.video\(a\.mp4\): gamut is one of 'rec709', .*'cinemagamut', not 'sgamut'\./,
  )
})
