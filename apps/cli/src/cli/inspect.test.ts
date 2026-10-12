import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatInspect } from './inspect.ts'

const json = {
  camera: { position: [2.571234, 1.21, 4.86], fov: 35 },
  title: { text: 'Hi', source: 'src/a.ts:3:7', on: true },
}

test('formatInspect prints one leaf per line', () => {
  assert.equal(
    formatInspect(json),
    [
      'camera.position [2.5712, 1.21, 4.86]',
      'camera.fov 35',
      'title.text "Hi"',
      'title.source src/a.ts:3:7',
      'title.on true',
    ].join('\n'),
  )
})

test('formatInspect starts at a path', () => {
  assert.equal(formatInspect(json, 'camera.fov'), 'camera.fov 35')
  assert.throws(() => formatInspect(json, 'nope'), /Nothing at nope/)
})

test('formatInspect uses diffJson paths for arrays', () => {
  const lines = { lines: [{ text: 'a' }, { text: 'b' }], parts: [{ id: 'leg', h: 1 }], 'x y': 2 }
  assert.equal(
    formatInspect(lines),
    [
      'lines[0].text "a"',
      'lines[1].text "b"',
      'parts[id=leg].id "leg"',
      'parts[id=leg].h 1',
      '["x y"] 2',
    ].join('\n'),
  )
  assert.equal(formatInspect(lines, 'lines[1].text'), 'lines[1].text "b"')
  assert.equal(formatInspect(lines, 'parts[id=leg].h'), 'parts[id=leg].h 1')
})
