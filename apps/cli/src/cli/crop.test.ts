import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Json } from '@shaderera/core'
import { crop, objectRegion, parseRegion } from './crop.ts'

test('a crop is clamped to the frame and enlarged by whole pixels', () => {
  // 4×2 frame: pixel i has red i.
  const px = new Uint8Array(4 * 2 * 4)
  for (let i = 0; i < 8; i++) px.set([i, 0, 0, 255], i * 4)
  const c = crop(px, { width: 4, height: 2 }, { x: 2, y: 1, width: 5, height: 5 }, 2)
  assert.deepEqual(c.region, { x: 2, y: 1, width: 2, height: 1 })
  assert.equal(c.width, 4)
  assert.equal(c.height, 2)
  assert.deepEqual(
    [...c.pixels].filter((_, i) => i % 4 === 0),
    [6, 6, 7, 7, 6, 6, 7, 7],
  )
  assert.throws(() => crop(px, { width: 4, height: 2 }, parseRegion('10,10,2,2')), /outside/)
  assert.throws(
    () => crop(px, { width: 4, height: 2 }, parseRegion('0,0,1,1'), 1.5),
    /whole number/,
  )
})

test('an object region comes from its bbox in inspect, else its box', () => {
  const json: Json = {
    shots: [
      { id: 'logo', bbox: [10, 20, 30, 40] },
      { id: 'tag', bbox: { x: 1, y: 2, width: 3, height: 4 } },
      { id: 'title', text: 'Hello', box: [160, 236, 420, 84] },
      { id: 'both', bbox: [1, 1, 2, 2], box: [0, 0, 9, 9] },
      { id: 'bare' },
    ],
  }
  assert.deepEqual(objectRegion(json, 'logo'), { x: 10, y: 20, width: 30, height: 40 })
  assert.deepEqual(objectRegion(json, 'tag'), { x: 1, y: 2, width: 3, height: 4 })
  assert.deepEqual(objectRegion(json, 'title'), { x: 160, y: 236, width: 420, height: 84 })
  assert.deepEqual(objectRegion(json, 'both'), { x: 1, y: 1, width: 2, height: 2 })
  assert.throws(() => objectRegion(json, 'bare'), /has no bbox or box/)
  assert.throws(() => objectRegion(json, 'nope'), /No object with id "nope"/)
  assert.throws(() => parseRegion('1,2,3'), /x,y,width,height/)
})
