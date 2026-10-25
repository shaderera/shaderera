import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { cli } from '../fixtures/cli.ts'
import { tempDir } from '../fixtures/temp.ts'
import { tail } from '../project/activity.ts'
import { addComment, waitDir } from '../project/comments.ts'
import { createServer } from './mcp.ts'

const bin = fileURLToPath(new URL('../../bin/shaderera.js', import.meta.url))

const project = () => {
  const root = tempDir('comments-cli')
  mkdirSync(join(root, 'src'))
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({ entry: './src/c.ts', fps: 30, duration: 4, width: 640, height: 360 }),
  )
  writeFileSync(join(root, 'src', 'c.ts'), 'export default () => ({ render: async () => ({}) })\n')
  return root
}

/** An MCP client on the project, in memory: its tools give JSON. */
const mcp = async (root: string) => {
  const server = createServer(root)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  const call = async (name: string, args: { [k: string]: unknown }) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[]
      isError?: boolean
    }
    if (r.isError) throw new Error(r.content[0]?.text)
    return JSON.parse(r.content[0]?.text as string)
  }
  return { call, close: () => client.close() }
}

const json = async (...args: string[]) => {
  const r = await cli(...args, '--json')
  return { ...r, envelope: JSON.parse(r.stdout) }
}

test('the CLI and MCP give the same JSON, and the CLI adds and replies as MCP does', async () => {
  const root = project()
  const { call, close } = await mcp(root)
  try {
    const added = await json(
      'comments',
      'add',
      '--root',
      root,
      '--at',
      '1-2',
      '--box',
      '10,20,30,40',
      'the',
      'title',
    )
    assert.equal(added.status, 0, added.stdout)
    const [c] = added.envelope.result.comments
    assert.deepEqual(
      [c.t, c.to, c.frame, c.toFrame, c.box, c.size, c.text, c.by],
      [1, 2, 30, 60, [10, 20, 30, 40], [640, 360], 'the title', 'cli'],
    )
    const viaMcp = await call('comment_add', { t: 3, point: [5, 6], text: 'and the end' })
    assert.equal(viaMcp.comments[0].by, 'agent')

    for (const [args, tool] of [
      [['comments', '--root', root], { state: undefined }],
      [['comments', 'list', '--state', 'all', '--root', root], { state: 'all' }],
      [['comments', 'show', c.id, '--root', root], { id: c.id }],
    ] as const) {
      const r = await json(...args)
      assert.equal(r.status, 0, r.stdout)
      assert.deepEqual(r.envelope.result, await call('comments', tool))
    }
    const replied = await json('comments', 'reply', c.id, 'looking', '--root', root)
    assert.deepEqual(replied.envelope.result, await call('comments', { id: c.id }))
    assert.deepEqual(
      replied.envelope.result.comments[0].replies.map((r: { text: string }) => r.text),
      ['looking'],
    )
  } finally {
    await close()
  }
})

test('reply --fixed on an unchanged tree exits 2 with the refusal; only the person resolves', async () => {
  const root = project()
  const { call, close } = await mcp(root)
  try {
    const c = await addComment(root, { t: 1, text: 'too dark' }, 'person')
    const unchanged = await cli('comments', 'reply', c.id, '--fixed', 'brighter', '--root', root)
    assert.equal(unchanged.status, 2)
    assert.match(unchanged.stderr, /Refusing to mark .* fixed: nothing changed since/)
    await assert.rejects(
      call('comment_reply', { id: c.id, text: 'x', fixed: true }),
      /nothing changed since/,
    )

    writeFileSync(join(root, 'src', 'c.ts'), '// brighter\n')
    const fixed = await call('comment_reply', { id: c.id, text: 'brighter now', fixed: true })
    assert.equal(fixed.comments[0].state, 'fixed')
    assert.match(fixed.comments[0].fixedIn, /^[0-9a-f]{16}$/)
    // The fix is its own record: no tool entry for it; the refused calls have one each.
    const tools = tail(root, 100).filter((e) => e.kind === 'tool' && e.tool === 'comment_reply')
    assert.deepEqual(
      tools.map((e) => e.kind === 'tool' && e.ok),
      [false],
    )
    // Fixed again with nothing changed since that fix: refused.
    await assert.rejects(
      call('comment_reply', { id: c.id, text: 'again', fixed: true }),
      /nothing changed since its last fix/,
    )
    // Just fixed: the tree is the fix's, so show does not say it changed since.
    const shown = await cli('comments', 'show', c.id, '--root', root)
    assert.match(shown.stdout, /fixed in [0-9a-f]{16}\r?\n/)
    assert.doesNotMatch(shown.stdout, /has changed since/)
    // A time reads to the millisecond; JSON keeps it whole.
    const third = await addComment(root, { t: 1 / 3, text: 'a third in' }, 'person')
    assert.match((await cli('comments', 'show', third.id, '--root', root)).stdout, /0\.333 s \(/)
    assert.equal((await call('comments', { id: third.id })).comments[0].t, 1 / 3)
    writeFileSync(join(root, 'src', 'c.ts'), '// brighter still\n')
    assert.match(
      (await cli('comments', 'show', c.id, '--root', root)).stdout,
      /\(the tree has changed since the fix\)/,
    )

    // This CLI runs off a terminal: an agent's, so it may not resolve. Nor may MCP.
    const resolve = await cli('comments', 'resolve', c.id, '--root', root)
    assert.equal(resolve.status, 2)
    assert.match(resolve.stderr, /Resolve it in the studio: only the person resolves/)
    await assert.rejects(
      call('comment_resolve', { id: c.id }),
      /Resolve it in the studio: only the person resolves/,
    )
    assert.equal(
      (await call('comment_resolve', { id: c.id, reopen: true })).comments[0].state,
      'open',
    )
  } finally {
    await close()
  }
})

test('--wait keeps comments.wait, and exits within 1 s of a comment another process writes', async () => {
  const root = project()
  // One already open: --wait waits for the next.
  await addComment(root, { t: 0.5, text: 'old' }, 'person')
  const child = spawn(process.execPath, [bin, 'comments', '--wait', '--json', '--root', root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', (d) => {
    out += d
  })
  const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)))
  try {
    const until = Date.now() + 20_000
    while (!existsSync(join(waitDir(root), String(child.pid)))) {
      assert.ok(Date.now() < until, "the waiter's file never appeared")
      await new Promise((r) => setTimeout(r, 50))
    }
    await new Promise((r) => setTimeout(r, 300))
    const c = await addComment(root, { t: 2, text: 'new one' }, 'person')
    const written = Date.now()
    assert.equal(await exited, 0)
    const ms = Date.now() - written
    assert.ok(ms < 1000, `woke ${ms} ms after the comment`)
    const result = JSON.parse(out).result
    assert.deepEqual(
      result.comments.map((x: { id: string }) => x.id),
      [c.id],
    )
    assert.equal(existsSync(join(waitDir(root), String(child.pid))), false)
  } finally {
    child.kill()
  }
})
