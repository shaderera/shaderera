// look-film-grain, headless on Dawn. Checked: amount 0 is the frame; on mid-grey the grain's σ is
// the amount, at a pixel's size and at a larger one, and the mean holds; with midtones 1, black and
// white stay clean; mono grain is the same on every channel, colour grain is not; the seed decides.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createGrain } from '../look-film-grain/src/looks/grain.ts'
import { grey, openFrame } from './frame.ts'

const W = 256
const H = 128

const stats = (b: Uint8Array) => {
  let sum = 0
  let sq = 0
  const n = b.length / 4
  for (let i = 0; i < b.length; i += 4) {
    sum += b[i] ?? 0
    sq += (b[i] ?? 0) ** 2
  }
  const mean = sum / n
  return { mean, sigma: Math.sqrt(sq / n - mean * mean) }
}

test('look-film-grain: strength, size, tones, channels and seed', async () => {
  const g = await openFrame(W, H)
  const grain = createGrain(g.host, { width: W, height: H })
  const mid = g.frame(() => grey(128))

  assert.deepEqual(await g.read(grain.apply(mid.texture, { amount: 0 })), mid.px)
  for (const size of [1, 4]) {
    const s = stats(await g.read(grain.apply(mid.texture, { amount: 0.05, size, midtones: 0 })))
    assert.ok(Math.abs(s.sigma / (0.05 * 255) - 1) < 0.15, `size ${size}: σ ${s.sigma.toFixed(2)}`)
    assert.ok(Math.abs(s.mean - 128) < 1, `size ${size}: the mean holds`)
  }

  const ends = g.frame((x) => grey(x < W / 2 ? 0 : 255))
  assert.deepEqual(await g.read(grain.apply(ends.texture, { amount: 0.2, midtones: 1 })), ends.px)

  const mono = await g.read(grain.apply(mid.texture, { amount: 0.1, seed: 2 }))
  for (let i = 0; i < mono.length; i += 4)
    assert.ok(mono[i] === mono[i + 1] && mono[i] === mono[i + 2])
  const colour = await g.read(grain.apply(mid.texture, { amount: 0.1, colour: 1, seed: 2 }))
  let apart = 0
  for (let i = 0; i < colour.length; i += 4) if (colour[i] !== colour[i + 1]) apart++
  assert.ok(apart > (colour.length / 4) * 0.5, 'colour grain differs by channel')

  assert.deepEqual(await g.read(grain.apply(mid.texture, { amount: 0.1, seed: 2 })), mono)
  assert.notDeepEqual(await g.read(grain.apply(mid.texture, { amount: 0.1, seed: 3 })), mono)
  grain.dispose()
  g.done()
})
