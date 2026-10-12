import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Canvas } from '@napi-rs/canvas'
import { drawSlate } from '../format-broadcast-slate/src/delivery/slate.ts'

const mean = (ctx: OffscreenCanvasRenderingContext2D, w: number, h: number) => {
  const d = ctx.getImageData(0, 0, w, h).data
  let sum = 0
  for (let i = 0; i < d.length; i += 4) sum += d[i] as number
  return sum / (w * h)
}

test('format-broadcast-slate: details and a countdown before the programme, black at the end, nothing after', () => {
  const canvas = new Canvas(320, 180)
  const ctx = canvas.getContext('2d') as unknown as OffscreenCanvasRenderingContext2D
  const o = { width: 320, height: 180, fields: { Title: 'Spring sale', Duration: '30"' } }
  assert.equal(drawSlate(ctx, -7.5, o), true)
  assert.ok(mean(ctx, 320, 180) > 1, 'text on the slate')
  assert.equal(drawSlate(ctx, -1.5, o), true)
  assert.equal(mean(ctx, 320, 180), 0, 'black for the last 2 s')
  assert.equal(drawSlate(ctx, 0, o), false)
})
