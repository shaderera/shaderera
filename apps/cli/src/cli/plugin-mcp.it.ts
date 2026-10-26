// The Claude Code plugin's launcher (plugins/shaderera/mcp.mjs), end to end: it runs the published
// `npx -y shaderera mcp`, so this needs the npm registry or a warm npx cache.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const launcher = fileURLToPath(new URL('../../../../plugins/shaderera/mcp.mjs', import.meta.url))

const cwd = join(fileURLToPath(import.meta.url), '..')

test('the plugin launcher starts the server, which answers initialize inside 30 s', {
  timeout: 300_000,
}, async () => {
  // The first start after a release installs the package from the registry, as long as the
  // network takes (#422). A start whose stdin is closed at once ends once it has: the start timed
  // below is the one a session makes every time after that.
  const warm = spawn(process.execPath, [launcher], { cwd, stdio: ['pipe', 'ignore', 'inherit'] })
  warm.stdin.end()
  assert.equal(await new Promise((resolve) => warm.on('exit', resolve)), 0)
  const t0 = Date.now()
  const child = spawn(process.execPath, [launcher], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d
  })
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    })}\n`,
  )
  const answer = await new Promise<{ result?: { serverInfo?: { name: string } } }>(
    (resolve, reject) => {
      let out = ''
      const timer = setTimeout(() => reject(new Error(`no answer in 60 s: ${stderr}`)), 60_000)
      child.stdout.on('data', (d) => {
        out += d
        const line = out.split('\n').find((l) => l.includes('"id":1'))
        if (line) {
          clearTimeout(timer)
          resolve(JSON.parse(line))
        }
      })
    },
  )
  const ms = Date.now() - t0
  assert.equal(answer.result?.serverInfo?.name, 'shaderera')
  assert.ok(ms < 30_000, `${ms} ms`)
  // No shell with an argument list (DEP0190), nor any other warning from the launcher.
  assert.doesNotMatch(stderr, /DEP0190|DeprecationWarning/)
  // Closing stdin ends the server, npx and the launcher.
  child.stdin.end()
  assert.equal(await exited, 0)
})
