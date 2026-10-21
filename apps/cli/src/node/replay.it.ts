import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { openBrowserChild } from './browser.ts'
import type { Child } from './child.ts'
import { findProject } from './project.ts'

/**
 * Sequential replay in the browser host with a DOM the state depends on (fixtures/dom-feedback):
 * every stepped frame must see its own DOM, and a camera override must restart the state. Needs
 * Chrome; without it these fail.
 */
const project = await findProject(join(import.meta.dirname, 'fixtures', 'dom-feedback'))
const state = async (child: Child, f: number) => {
  const { pixels } = await child.render(f / 10, 'final')
  return (pixels[0] as number) + (pixels[1] as number) * 256
}
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

test('DOM-fed state: play, direct, backward, repeated and looped frames agree, and inspect with them', async () => {
  const a = await openBrowserChild(project)
  const b = await openBrowserChild(project)
  try {
    let played = 0
    for (let f = 0; f <= 9; f++) played = await state(a, f)
    // By hand: bar(f) = 3f; s(f) = floor(s(f-1)/2) + 3f.
    let want = 0
    for (let f = 0; f <= 9; f++) want = Math.floor(want / 2) + 3 * f
    assert.equal(played, want)
    assert.equal(await state(b, 9), played, 'direct seek')
    assert.equal(await state(b, 9), played, 'repeated frame')
    await state(b, 15)
    assert.equal(await state(b, 9), played, 'backward seek')
    await state(b, 19)
    await state(b, 0)
    assert.equal(await state(b, 9), played, 'loop')
    assert.deepEqual(await b.inspect(0.9), { state: played }, 'inspect at the rendered frame')
    assert.deepEqual(await b.inspect(0.4), { state: await state(a, 4) }, 'inspect-driven replay')
  } finally {
    await a.close()
    await b.close()
  }
})

test('a camera override restarts camera-dependent state: equal to a fresh source under it', async () => {
  const a = await openBrowserChild(project)
  const b = await openBrowserChild(project)
  try {
    await state(a, 5)
    await a.override({ view: I, projection: I })
    await b.override({ view: I, projection: I })
    assert.equal(await state(a, 7), await state(b, 7))
  } finally {
    await a.close()
    await b.close()
  }
})
