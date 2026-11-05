import assert from 'node:assert/strict'
import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'
import { findProject } from './project.ts'
import { RUNNER_PATH, SERVICE_PATH } from './runner-plugin.ts'
import { HOST, startRunner } from './runner-server.ts'

const tiny = fileURLToPath(new URL('./fixtures/tiny/', import.meta.url))

test('a service request without the runner token is refused', async () => {
  const root = tempDir('token')
  cpSync(tiny, root, { recursive: true, filter: (p) => !p.includes('.shaderera') })
  const { server: runner, port } = await startRunner(await findProject(root), {
    pkgDir: fileURLToPath(new URL('../..', import.meta.url)),
    studioOrigins: [],
    cacheDir: join(root, '.shaderera', 'vite'),
  })
  try {
    const origin = `http://${HOST}:${port}`
    const hash = 'a'.repeat(64)
    const put = (token: string) =>
      fetch(`${origin}${SERVICE_PATH}cache-put?hash=${hash}&token=${token}`, {
        method: 'POST',
        body: 'planted',
      })
    assert.equal((await put('')).status, 403)
    assert.ok(!existsSync(join(root, '.shaderera', 'cache', hash)))
    const module = await (await fetch(`${origin}/__shaderera/token.js`)).text()
    const token = /"([0-9a-f-]{36})"/.exec(module)?.[1] ?? ''
    assert.equal((await put(token)).status, 204)
    assert.ok(existsSync(join(root, '.shaderera', 'cache', hash)))
  } finally {
    await runner.close()
  }
})

test('the runner page names an empty icon, so Chrome asks for no favicon.ico', async () => {
  const root = tempDir('icon')
  cpSync(tiny, root, { recursive: true, filter: (p) => !p.includes('.shaderera') })
  const { server: runner, port } = await startRunner(await findProject(root), {
    pkgDir: fileURLToPath(new URL('../..', import.meta.url)),
    studioOrigins: [],
    cacheDir: join(root, '.shaderera', 'vite'),
  })
  try {
    const page = await (await fetch(`http://${HOST}:${port}${RUNNER_PATH}`)).text()
    assert.match(page, /<link rel="icon" href="data:,">/)
  } finally {
    await runner.close()
  }
})
