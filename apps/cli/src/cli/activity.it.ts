import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { cli } from '../fixtures/cli.ts'
import { tempDir } from '../fixtures/temp.ts'
import { tail } from '../project/activity.ts'
import { createServer } from './mcp.ts'

/** fixtures/params in a temp folder of its own: a 1 s film, a grey param. */
const project = () => {
  const root = tempDir('activity')
  cpSync(fileURLToPath(new URL('./fixtures/params/', import.meta.url)), root, {
    recursive: true,
    filter: (f) => !/[\\/](out|\.shaderera)$/.test(f),
  })
  return root
}

test('a command run in a project appends one entry: its exit code and its findings counted', async () => {
  const root = project()
  const ran = await cli('check', '--times', '2', '--root', root)
  assert.equal(ran.status, 0, ran.stderr)
  const [entry, ...more] = tail(root, 10)
  assert.equal(more.length, 0)
  assert.ok(entry?.kind === 'command')
  assert.equal(entry.by, 'cli')
  assert.equal(entry.command, 'check')
  assert.deepEqual(entry.args, ['--times', '2', '--root', root])
  assert.equal(entry.exitCode, 0)
  assert.equal(entry.ok, true)
  // The fixture has no tsconfig.json: its types were not checked, said once as info.
  assert.deepEqual(entry.summary, {
    error: 0,
    warning: 0,
    info: 1,
    messages: ['types not checked: the project has no typescript or no tsconfig.json'],
  })

  // One that fails: its exit code and its error, counted and quoted.
  const bad = await cli('inspect', '5', '--root', root)
  assert.equal(bad.status, 2)
  const failed = tail(root, 1)[0]
  assert.ok(failed?.kind === 'command')
  assert.equal(failed.exitCode, 2)
  assert.equal(failed.summary.error, 1)
  assert.match(failed.summary.messages[0] ?? '', /Outside the film/)

  // help, and activity itself, are no entries.
  await cli('check', '--help', '--root', root)
  await cli('activity', '--root', root)
  assert.equal(tail(root, 10).length, 2)
})

test('still --sheet keeps its contact sheet as the entry image', async () => {
  const root = project()
  const ran = await cli('still', '0', '0.5', '--sheet', '--root', root)
  assert.equal(ran.status, 0, ran.stderr)
  const entry = tail(root, 1)[0]
  assert.ok(entry?.image)
  assert.ok(statSync(join(root, entry.image)).size > 0)
})

test('a command outside a project appends nothing', async () => {
  const outside = tempDir('no-project')
  const ran = await cli('versions', '--root', outside)
  assert.equal(ran.status, 2)
  assert.equal(existsSync(join(outside, '.shaderera')), false)
})

test('a log that cannot be written leaves the exit code as it was', async () => {
  const root = project()
  // The log a folder, so every append fails, whatever the platform makes of read-only folders.
  mkdirSync(join(root, '.shaderera', 'activity.jsonl'), { recursive: true })
  assert.equal((await cli('check', '--times', '2', '--root', root)).status, 0)
  assert.equal((await cli('inspect', '5', '--root', root)).status, 2)
})

test('activity add appends a note; activity prints the log', async () => {
  const root = project()
  const added = await cli(
    'activity',
    'add',
    '--comment',
    'c7',
    'Making the logo bigger',
    '--root',
    root,
  )
  assert.equal(added.status, 0, added.stderr)
  const listed = await cli('activity', '--root', root)
  assert.match(listed.stdout, /agent\s+Making the logo bigger \(comment c7\)/)
  const json = JSON.parse((await cli('activity', '--json', '--root', root)).stdout)
  assert.equal(json.shaderera, 'result/1')
  assert.deepEqual(
    json.result.map((e: { kind: string; text: string; comment: string }) => [
      e.kind,
      e.text,
      e.comment,
    ]),
    [['note', 'Making the logo bigger', 'c7']],
  )
  assert.equal((await cli('activity', 'add', '--root', root)).status, 2)
})

test('MCP: every tool call appends one entry; still and render_frame with image keep their PNG', async () => {
  const root = project()
  const server = createServer(root)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  try {
    await client.callTool({ name: 'still', arguments: { times: [0, 0.5] } })
    await client.callTool({ name: 'render_frame', arguments: { t: 0.5 } })
    await client.callTool({ name: 'render_frame', arguments: { t: 0.5, image: true } })
    const failed = await client.callTool({ name: 'inspect', arguments: { t: 5 } })
    assert.equal(failed.isError, true)
    const noted = await client.callTool({
      name: 'activity_add',
      arguments: { text: 'Trying a warmer grey', comment: 'c1' },
    })
    assert.notEqual(noted.isError, true)
    const entries = tail(root, 10)
    assert.deepEqual(
      entries.map((e) => [
        e.by,
        e.kind,
        e.kind === 'tool' ? e.tool : e.kind === 'note' && e.text,
        !!e.image,
      ]),
      [
        ['agent', 'tool', 'still', true],
        ['agent', 'tool', 'render_frame', false],
        ['agent', 'tool', 'render_frame', true],
        ['agent', 'tool', 'inspect', false],
        ['agent', 'note', 'Trying a warmer grey', false],
      ],
    )
    const tool = entries[3]
    assert.ok(tool?.kind === 'tool')
    assert.equal(tool.ok, false)
    assert.ok(tool.ms >= 0)
    assert.match(tool.summary?.messages[0] ?? '', /Outside the film/)
    const image = entries[0]?.image
    assert.ok(image)
    assert.ok(statSync(join(root, image)).size > 0)
  } finally {
    await client.close()
  }
})
