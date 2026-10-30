import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from './mcp.ts'

/** A client on the server, without opening any project. */
const connected = async () => {
  const server = createServer(process.cwd(), {})
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

/** The tools the server lists. */
const listTools = async () => {
  const client = await connected()
  try {
    return (await client.listTools()).tools
  } finally {
    await client.close()
  }
}

test("check's samples give their default, and the CLI's", async () => {
  const check = (await listTools()).find((t) => t.name === 'check')
  const samples = check?.inputSchema.properties?.samples as { description?: string }
  assert.match(samples.description ?? '', /default 20, where the CLI's check takes 50/)
  assert.equal(check?.inputSchema.properties?.times, undefined)
})

test('every tool has a title, annotations and a description for each property', async () => {
  const tools = await listTools()
  const looking = [
    'render_frame',
    'still',
    'inspect',
    'compare',
    'pick',
    'get_camera',
    'get_source',
    'check',
    'versions',
    'diff',
    'comments',
  ]
  for (const t of tools) {
    assert.ok(t.title, `${t.name} has a title`)
    assert.equal(t.annotations?.title, t.title)
    assert.equal(t.annotations?.readOnlyHint === true, looking.includes(t.name), t.name)
    if (!looking.includes(t.name))
      assert.equal(
        typeof t.annotations?.destructiveHint,
        'boolean',
        `${t.name} says if it destroys`,
      )
    assert.doesNotMatch(t.description ?? '', /^Like `shaderera/, t.name)
    for (const [k, p] of Object.entries(t.inputSchema.properties ?? {}))
      assert.ok((p as { description?: string }).description, `${t.name}.${k} has a description`)
  }
  const state = tools.find((t) => t.name === 'comments')?.inputSchema.properties?.state
  assert.deepEqual((state as { enum?: string[] } | undefined)?.enum, [
    'open',
    'fixed',
    'resolved',
    'all',
  ])
})

test('the server sends instructions: the loop, and that a whole film renders in the CLI', async () => {
  const client = await connected()
  try {
    const said = client.getInstructions() ?? ''
    assert.match(said, /inspect or render_frame .* → still .* → check .* → render/)
    assert.match(said, /npx shaderera render/)
  } finally {
    await client.close()
  }
})
