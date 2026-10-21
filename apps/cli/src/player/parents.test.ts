import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileFrom, isOrigin, parentOrigin } from './parents.ts'

const site = 'https://shaderera.com'
const preview = 'https://preview.shaderera.com'

test('the port goes to an allowed origin only: the one ?parent= names, else the first', () => {
  assert.equal(parentOrigin([site, preview], preview), preview)
  assert.equal(parentOrigin([site, preview], null), site)
  assert.equal(parentOrigin([site, preview], 'https://evil.example'), site)
  assert.equal(parentOrigin([], 'https://evil.example'), undefined)
  assert.ok(isOrigin(site) && isOrigin('http://127.0.0.1:8787'))
  for (const not of [
    'https://shaderera.com/',
    'https://shaderera.com/film/x',
    'shaderera.com',
    '*',
    'null',
  ])
    assert.ok(!isOrigin(not), not)
})

test("a viewer's file is taken from the framing window at the parent's origin, under a local: name only", () => {
  const parentWindow = {}
  const file = new Blob(['clip'])
  const data = { shaderera: 'file', name: 'local:1/clip.mp4', file }
  const ok = { source: parentWindow, origin: site, data }
  assert.deepEqual(fileFrom(ok, parentWindow, site), { name: 'local:1/clip.mp4', file })
  // Another window, another origin, an opaque one, or a player that has no parent: refused.
  assert.equal(fileFrom({ ...ok, source: {} }, parentWindow, site), undefined)
  assert.equal(fileFrom({ ...ok, origin: 'https://evil.example' }, parentWindow, site), undefined)
  assert.equal(fileFrom({ ...ok, origin: 'null' }, parentWindow, site), undefined)
  assert.equal(fileFrom(ok, parentWindow, undefined), undefined)
  // Not a local: clip, not a file, not the message.
  for (const bad of [
    { ...data, name: 'assets/clip.mp4' },
    { ...data, file: 'clip' },
    { ...data, shaderera: 'runner' },
    null,
  ])
    assert.equal(fileFrom({ ...ok, data: bad }, parentWindow, site), undefined)
})
