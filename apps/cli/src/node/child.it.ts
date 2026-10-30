import assert from 'node:assert/strict'
import { cpSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'
import { buildForNode } from './build.ts'
import { openChild, TIMEOUT } from './child.ts'
import { findProject } from './project.ts'

const tiny = fileURLToPath(new URL('./fixtures/tiny/', import.meta.url))

test('a hung source fails the call after timeoutMs and closes without a crash', async () => {
  const root = tempDir('hang')
  cpSync(tiny, root, { recursive: true, filter: (p) => !p.includes('.shaderera') })
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    'export default () => ({ render: async () => { for (;;) {} } })\n',
  )
  const project = await findProject(root)
  const child = await openChild(project, {
    entryFile: await buildForNode(project),
    // Only the hung call is timed: opening has the default allowance, as in dom.it.ts.
    timeoutMs: 500,
    openTimeoutMs: TIMEOUT,
  })
  await assert.rejects(
    child.render(0, 'final'),
    /took longer than 500 ms on render at t = 0 s without a sign of work: .*--timeout <s>/,
  )
  await child.close()
  await assert.rejects(child.render(0, 'final'), /has exited/)
})

test('a host that exits fails the call with its last lines of stderr, not only its code (#530)', async () => {
  const root = tempDir('dies')
  cpSync(tiny, root, { recursive: true, filter: (p) => !p.includes('.shaderera') })
  // Thrown outside any call: the host dies of it with code 1.
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    `export default ({ io }) => {
  const canvas = io.canvas(64, 36)
  return {
    render: async () => {
      setTimeout(() => { throw new Error('the source died out of turn') })
      await new Promise((done) => setTimeout(done, 1000))
      return { color: canvas }
    },
  }
}
`,
  )
  const project = await findProject(root)
  const child = await openChild(project, { entryFile: await buildForNode(project) })
  await assert.rejects(
    child.render(0, 'final'),
    /^Error: The source process exited \(1\)\. Its last output:\n[\s\S]*the source died out of turn/,
  )
  await child.close()
})

test('a frame announced whose bytes never come on the pipe fails the call after timeoutMs (#439)', async () => {
  const root = tempDir('dropped')
  cpSync(tiny, root, { recursive: true, filter: (p) => !p.includes('.shaderera') })
  // Big enough to go on the pipe (BULK_MIN), not in the IPC message.
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({
      entry: './src/composition.ts',
      fps: 10,
      duration: 1,
      width: 256,
      height: 144,
    }),
  )
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    'export default ({ io }) => { const c = io.canvas(256, 144); return { render: async () => [{ color: c }] } }\n',
  )
  const project = await findProject(root)
  process.env.SHADERERA_TEST_DROP_FRAMES = '1'
  const child = await openChild(project, {
    entryFile: await buildForNode(project),
    timeoutMs: 500,
    openTimeoutMs: TIMEOUT,
  }).finally(() => delete process.env.SHADERERA_TEST_DROP_FRAMES)
  await assert.rejects(
    child.render(0, 'final'),
    /took longer than 500 ms on render at t = 0 s without a sign of work/,
  )
  await child.close()
})

test("a sequential source's call outlasts timeoutMs while each frame it steps through is in time", async () => {
  const root = tempDir('steps')
  cpSync(fileURLToPath(new URL('./fixtures/sequential/', import.meta.url)), root, {
    recursive: true,
    filter: (p) => !p.includes('.shaderera'),
  })
  // 300 ms a frame: render(0.9) steps 10 frames, 3 s in one call.
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    `export default () => ({
  render: async () => {
    await new Promise((done) => setTimeout(done, 300))
    return { color: new Uint8Array(4 * 2 * 4).fill(255), alpha: 'opaque' }
  },
})
`,
  )
  const project = await findProject(root)
  const child = await openChild(project, {
    entryFile: await buildForNode(project),
    timeoutMs: 1000,
    openTimeoutMs: TIMEOUT,
  })
  try {
    const start = performance.now()
    await child.render(0.9, 'final')
    assert.ok(performance.now() - start > 2500)
  } finally {
    await child.close()
  }
})

test('a call outlasts timeoutMs while the source keeps asking this process for things (io.cache)', async () => {
  const root = tempDir('asking')
  cpSync(tiny, root, { recursive: true, filter: (p) => !p.includes('.shaderera') })
  // Six cache entries made 400 ms apart: 2.4 s in one call, never 1 s without a request.
  writeFileSync(
    join(root, 'src', 'composition.ts'),
    `export default ({ io }) => {
  const canvas = io.canvas(64, 36)
  return {
    render: async (t) => {
      for (let i = 0; i < 6; i++)
        await io.cache(\`step-\${t}-\${i}\`, [], async () => {
          await new Promise((done) => setTimeout(done, 400))
          return new Uint8Array(1)
        })
      return { color: canvas }
    },
  }
}
`,
  )
  const project = await findProject(root)
  const child = await openChild(project, {
    entryFile: await buildForNode(project),
    timeoutMs: 1000,
    openTimeoutMs: TIMEOUT,
  })
  try {
    const start = performance.now()
    await child.render(0, 'final')
    assert.ok(performance.now() - start > 2000)
  } finally {
    await child.close()
  }
})
