import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Ask, extraIo, fitSize } from './io.ts'

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

test('io.video asks every frame at the maxSize it was opened with, carries no maxSize in its space, and refuses one that is not whole pixels (#507)', async () => {
  const asked: unknown[] = []
  const ask = {
    videoOpen: async (path: string, declared?: boolean, maxSize?: number) => {
      asked.push(['open', path, declared, maxSize])
      const colour = { matrix: 'bt709', range: 'limited', chroma: 'left' } as const
      return { width: 20, height: 11, fps: 10, frames: 4, bits: 8, colour } as const
    },
    videoFrame: async (path: string, index: number, format: string, maxSize?: number) => {
      asked.push(['frame', path, index, format, maxSize])
      return new Uint8Array(20 * 11 * 4)
    },
  } as unknown as Ask
  const io = extraIo(async () => new Uint8Array(), ask)
  const clip = await io.video('a.mp4', { maxSize: 20, transfer: 'bt709' })
  assert.deepEqual(clip.space, { transfer: 'bt709' })
  await clip.frame(2, { format: 'yuv420p' })
  const small = await io.video('b.mp4', { maxSize: 20 })
  assert.equal('space' in small, false)
  assert.deepEqual(asked, [
    ['open', 'a.mp4', true, 20],
    ['frame', 'a.mp4', 2, 'yuv420p', 20],
    ['open', 'b.mp4', false, 20],
  ])
  for (const bad of [0, 2.5, -4, 70000])
    await assert.rejects(io.video('a.mp4', { maxSize: bad }), {
      message: `io.video(a.mp4): maxSize is a whole number of pixels, not ${bad}.`,
    })
})

test("fitSize is io.image's maxSize rule: the long side to it, the short rounded half up, never below 1", () => {
  assert.deepEqual(fitSize(1920, 1080, 480), { width: 480, height: 270 })
  assert.deepEqual(fitSize(1080, 1920, 480), { width: 270, height: 480 })
  assert.deepEqual(fitSize(64, 36, 20), { width: 20, height: 11 })
  // 4.5 rounds up; a sliver stays a pixel.
  assert.deepEqual(fitSize(8, 9, 4), { width: 4, height: 4 })
  assert.deepEqual(fitSize(16, 1, 4), { width: 4, height: 1 })
  assert.deepEqual(fitSize(1000, 1, 4), { width: 4, height: 1 })
  // Within it, or none: its own size.
  assert.deepEqual(fitSize(64, 36, 64), { width: 64, height: 36 })
  assert.deepEqual(fitSize(64, 36), { width: 64, height: 36 })
})
