import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from './mcp.ts'

/** The tools the server lists, without opening any project. */
const listTools = async () => {
  const server = createServer(process.cwd(), {})
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  try {
    return (await client.listTools()).tools
  } finally {
    await client.close()
  }
}

test("check's description gives its default times, and the CLI's", async () => {
  const check = (await listTools()).find((t) => t.name === 'check')
  assert.match(check?.description ?? '', /default 20, where the CLI's check takes 50/)
})
