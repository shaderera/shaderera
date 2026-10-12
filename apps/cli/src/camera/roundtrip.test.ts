import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { diffPixels } from '@shaderera/core'
import { buildForNode } from '../node/build.ts'
import { openChild } from '../node/child.ts'
import { findProject } from '../node/project.ts'

/**
 * The camera gate: rendering through the source's own camera must equal overriding the camera
 * with what `camera.get(t)` reports and rendering again. Tolerance: 0 in every channel.
 */
for (const name of ['3d-product', 'camera-debug']) {
  test(`${name}: render(t) equals override(camera.get(t)); render(t)`, async () => {
    const root = fileURLToPath(
      new URL(
        name === 'camera-debug' ? '../cli/fixtures/camera-debug/' : `../../fixtures/${name}/`,
        import.meta.url,
      ),
    )
    const project = await findProject(root)
    const child = await openChild(project, { entryFile: await buildForNode(project) })
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
        console.log(`${name} t=${t} max=${d.max} mean=${d.mean} differing=${d.differing}`)
        assert.equal(d.max, 0)
      }
      // The override really drives the render: another t's camera changes the picture.
      await child.override(await child.camera(0))
      const moved = await child.render(5.2, 'final')
      await child.override(null)
      assert.ok(diffPixels(moved.pixels, (await child.render(5.2, 'final')).pixels).differing > 0)
    } finally {
      await child.close()
    }
  })
}
