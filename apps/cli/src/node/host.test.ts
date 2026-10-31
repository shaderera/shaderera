import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'

const alive = (pid: number) => {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

/** A project whose source holds the host's event loop, as Dawn's GPU object does. */
const held = () => {
  const root = tempDir('orphan')
  mkdirSync(join(root, 'src'))
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({ entry: './src/c.ts', fps: 10, duration: 1, width: 8, height: 8 }),
  )
  writeFileSync(
    join(root, 'src', 'c.ts'),
    `export default ({ io }) => {
      setInterval(() => {}, 1000)
      const canvas = io.canvas(8, 8)
      return { render: async () => ({ color: canvas }), inspect: async () => ({ pid: process.pid }) }
    }`,
  )
  return root
}

const parentScript = fileURLToPath(new URL('./fixtures/host-parent.ts', import.meta.url))

for (const mode of ['killed', 'disconnect'])
  test(`a Node host whose parent is gone (${mode}) ends, though its event loop is held`, async () => {
    const parent = spawn(process.execPath, [parentScript, held(), mode], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let host = 0
    try {
      host = await new Promise<number>((done, fail) => {
        parent.stdout.once('data', (d) => done(JSON.parse(String(d)).pid))
        parent.once('exit', (code) => fail(new Error(`the parent exited (${code})`)))
      })
      // As an MCP client ends `shaderera mcp`: by PID, which leaves its children on Linux and macOS.
      if (mode === 'killed') {
        const gone = new Promise((done) => parent.once('exit', done))
        parent.kill()
        await gone
      }
      for (let i = 0; i < 50 && alive(host); i++) await new Promise((r) => setTimeout(r, 100))
      assert.equal(alive(host), false, 'the host outlived its parent')
    } finally {
      if (alive(parent.pid as number)) parent.kill()
      if (host && alive(host)) process.kill(host)
    }
  })
