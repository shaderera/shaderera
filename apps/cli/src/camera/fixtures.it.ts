import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { diffPixels } from '@shaderera/core'
import { buildForNode } from '../node/build.ts'
import { openChild } from '../node/child.ts'
import { findProject } from '../node/project.ts'

/** The workspace fixtures: the hybrid's camera round trip and screen layer, and pick. */

const open = async (name: string) => {
  const root = fileURLToPath(new URL(`../../fixtures/${name}/`, import.meta.url))
  const project = await findProject(root)
  const child = await openChild(project, { entryFile: await buildForNode(project) })
  return { child, width: project.manifest.width, height: project.manifest.height }
}

type Box = [number, number, number, number]
type Obj = { id: string; box?: Box; position?: number[] }

test('hybrid: render(t) equals override(camera.get(t)); render(t)', async () => {
  const { child } = await open('hybrid')
  try {
    assert.ok(child.has.camera)
    for (const t of [0.5, 2.7, 5.2]) {
      const own = await child.render(t, 'final')
      const m = await child.camera(t)
      assert.ok(m)
      await child.override(m)
      const through = await child.render(t, 'final')
      await child.override(null)
      const d = diffPixels(own.pixels, through.pixels)
      console.log(`hybrid t=${t} max=${d.max} mean=${d.mean} differing=${d.differing}`)
      assert.equal(d.max, 0)
    }
  } finally {
    await child.close()
  }
})

test('hybrid: an override moves the world layer and never the screen plate', async () => {
  const { child, width, height } = await open('hybrid')
  try {
    const t = 4.2
    const state = (await child.inspect(t)) as { screen: Obj[] }
    const [px, py, pw, ph] = (state.screen.find((o) => o.id === 'plate')?.box ?? []) as Box
    const authored = (await child.render(t, 'final')).pixels
    await child.override(await child.camera(0.5))
    const moved = (await child.render(t, 'final')).pixels
    await child.override(null)
    let plateDiff = 0
    let worldDiff = 0
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const d =
          authored[i] !== moved[i] ||
          authored[i + 1] !== moved[i + 1] ||
          authored[i + 2] !== moved[i + 2]
        if (!d) continue
        if (x >= px && x < px + pw && y >= py && y < py + ph) plateDiff++
        else worldDiff++
      }
    console.log(`hybrid plate ${pw}x${ph}: differing ${plateDiff}; outside: differing ${worldDiff}`)
    assert.equal(plateDiff, 0)
    assert.ok(worldDiff > 0)
  } finally {
    await child.close()
  }
})

test('pick: 2d-title headline box center and a 3d-product part with a point', async () => {
  const title = await open('2d-title')
  try {
    const state = (await title.child.inspect(2)) as { elements: Obj[] }
    const [x, y, w, h] = (state.elements.find((o) => o.id === 'headline')?.box ?? []) as Box
    const hit = await title.child.pick(2, x + w / 2, y + h / 2)
    console.log(`2d-title pick ${JSON.stringify(hit)}`)
    assert.equal(hit?.id, 'headline')
    assert.equal(hit?.point, undefined)
  } finally {
    await title.child.close()
  }
  const product = await open('3d-product')
  try {
    const t = 2
    const state = (await product.child.inspect(t)) as { parts: Obj[] }
    const body = state.parts.find((o) => o.id === 'body')?.position as number[]
    const m = await product.child.camera(t)
    assert.ok(m)
    // Project the part's world center through view and projection (column-major).
    const p = [body[0] as number, body[1] as number, body[2] as number, 1]
    const mul = (a: readonly number[], v: number[]) =>
      [0, 1, 2, 3].map((r) =>
        [0, 1, 2, 3].reduce((s, c) => s + (a[c * 4 + r] as number) * (v[c] as number), 0),
      )
    const clip = mul(m.projection, mul(m.view, p))
    const [cx = 0, cy = 0, , cw = 1] = clip
    const sx = ((cx / cw + 1) / 2) * product.width
    const sy = ((1 - cy / cw) / 2) * product.height
    const hit = await product.child.pick(t, sx, sy)
    console.log(`3d-product pick at ${sx.toFixed(1)},${sy.toFixed(1)}: ${JSON.stringify(hit)}`)
    assert.equal(hit?.id, 'body')
    assert.equal(hit?.point?.length, 3)
  } finally {
    await product.child.close()
  }
})
