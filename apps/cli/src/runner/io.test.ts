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
  assert.deepEqual(opened, [
    ['log.mp4', true],
    ['plain.mp4', false],
  ])
})
