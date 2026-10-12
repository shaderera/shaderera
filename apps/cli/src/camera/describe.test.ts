import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mat4 } from 'wgpu-matrix'
import { describeCamera } from './describe.ts'

const close = (a: readonly number[], b: readonly number[]) => {
  for (const [i, x] of a.entries()) {
    const y = b[i] as number
    assert.ok(Math.abs(x - y) <= 1e-5 * Math.max(1, Math.abs(y)), `${a} != ${b}`)
  }
}

test('describeCamera reads eye, axes and lens back from matrices', () => {
  const d = describeCamera({
    view: [...mat4.lookAt([3, 2, 5], [3, 2, 0], [0, 1, 0])],
    projection: [...mat4.perspective((50 * Math.PI) / 180, 16 / 9, 0.1, 100)],
  })
  close(d.eye, [3, 2, 5])
  close(d.forward, [0, 0, -1])
  close(d.up, [0, 1, 0])
  close([d.fovY, d.aspect, d.near, d.far], [50, 16 / 9, 0.1, 100])
})

test('describeCamera handles a tilted camera and an infinite far plane', () => {
  const d = describeCamera({
    view: [...mat4.lookAt([0, 4, 0], [0, 0, 0], [0, 0, -1])],
    projection: [...mat4.perspective(Math.PI / 2, 1, 0.5, Infinity)],
  })
  close(d.eye, [0, 4, 0])
  close(d.forward, [0, -1, 0])
  close(d.up, [0, 0, -1])
  close([d.fovY, d.aspect, d.near], [90, 1, 0.5])
  assert.equal(d.far, Infinity)
})
