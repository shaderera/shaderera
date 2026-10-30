import assert from 'node:assert/strict'
import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../cli/mcp.ts'
import { tempDir } from '../fixtures/temp.ts'
import { page } from './fixtures/page.ts'
import { startRelay } from './fixtures/relay.ts'

// The user's settings (telemetry's notice) live in a home of the test's own; the studio it starts
// inherits it.
const home = tempDir('home')
process.env.HOME = home
process.env.USERPROFILE = home
delete process.env.SHADERERA_TELEMETRY

test('MCP studio starts the studio and returns its address, the same one again, and stops it', {
  timeout: 300_000,
}, async () => {
  const relay = await startRelay()
  const root = tempDir('mcp-studio')
  cpSync(fileURLToPath(new URL('../cli/fixtures/params/', import.meta.url)), root, {
    recursive: true,
  })
  const server = createServer(root, { studio: ['--site', relay.origin, '--no-open'] })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  // biome-ignore lint/suspicious/noExplicitAny: tool results are JSON
  const call = async (args: { [k: string]: unknown }): Promise<any> => {
    const r = (await client.callTool({ name: 'studio', arguments: args })) as {
      content: { text: string }[]
      isError?: boolean
    }
    if (r.isError) throw new Error(r.content[0]?.text)
    return JSON.parse(r.content[0]?.text as string)
  }
  try {
    const first = await call({})
    assert.match(first.url, /\/studio\/[A-Za-z0-9]+#/)
    assert.equal(first.project, root)
    assert.equal(first.opened, false)
    const again = await call({})
    assert.equal(again.id, first.id)
    assert.equal(again.reused, true)

    const p = page(relay.origin, first.id)
    await p.pair(new URL(first.url).hash.slice(1))
    const stopped = await call({ stop: true })
    assert.equal(stopped.stopped, true)
    // The session ended at the relay: the page is told the CLI stopped.
    assert.equal(await p.closed, 4004)
    assert.equal(existsSync(join(root, '.shaderera', 'studio', 'bridge.json')), false)
    assert.match((await call({ stop: true })).text, /No studio is running/)
    p.ws.close()

    // A studio lives as long as the server: it ends with it.
    await call({})
    const file = join(root, '.shaderera', 'studio', 'bridge.json')
    assert.equal(existsSync(file), true)
    await client.close()
    for (let i = 0; i < 300 && existsSync(file); i++) await sleep(100)
    assert.equal(existsSync(file), false)
  } finally {
    await client.close()
    await relay.close()
  }
})
