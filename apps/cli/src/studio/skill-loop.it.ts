// The skill's studio comment loop (plugins/shaderera/skills/shaderera/SKILL.md, "Working with the
// person in the studio"), run by a scripted agent that uses only what the section names: the
// person comments through the bridge, as the page does, and the agent hears it with
// `comments --wait`, looks, fixes, checks and replies fixed, and never resolves.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../cli/mcp.ts'
import { tempDir } from '../fixtures/temp.ts'
import { type Bridge, startBridge } from './bridge.ts'
import { call } from './fixtures/page.ts'

const home = tempDir('home')
process.env.HOME = home
process.env.USERPROFILE = home
const SITE = 'https://shaderera.example'
const bin = fileURLToPath(new URL('../../bin/shaderera.js', import.meta.url))
const skill = readFileSync(
  fileURLToPath(
    new URL('../../../../plugins/shaderera/skills/shaderera/SKILL.md', import.meta.url),
  ),
  'utf8',
)
const section = skill.slice(
  skill.indexOf('## 6. Working with the person in the studio'),
  skill.indexOf('## 7.'),
)

const root = tempDir('skill-loop')
cpSync(fileURLToPath(new URL('../cli/fixtures/params/', import.meta.url)), root, {
  recursive: true,
})
let bridge: Bridge
before(async () => {
  bridge = await startBridge({ root, api: SITE, site: SITE, origins: [SITE], settleMs: 50 })
})
after(() => bridge.close())

/** The page's side of the bridge. */
const page = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
  const r = await call(bridge.port, {
    method,
    path,
    headers: { Origin: SITE, Authorization: `Bearer ${bridge.secret}` },
    ...(body === undefined ? {} : { body }),
  })
  assert.equal(r.status, 200, r.body.toString())
  return JSON.parse(r.body.toString('utf8'))
}

test('a scripted agent following the skill hears a comment, fixes it, replies fixed, never resolves', async () => {
  // The agent's tools: MCP, as the plugin declares it, and the CLI.
  const server = createServer(root)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'agent', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  const used = new Set<string>()
  // biome-ignore lint/suspicious/noExplicitAny: tool results are JSON
  const mcp = async (name: string, args: { [k: string]: unknown }): Promise<any> => {
    used.add(name)
    const r = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[]
      isError?: boolean
    }
    if (r.isError) throw new Error(r.content[0]?.text)
    return JSON.parse(r.content[0]?.text as string)
  }
  try {
    // 1. Listen: `comments --wait --json` in the background.
    const waiter = spawn(process.execPath, [bin, 'comments', '--wait', '--json', '--root', root], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    waiter.stdout.on('data', (d) => {
      out += d
    })
    const heard = new Promise<number | null>((r) => waiter.on('exit', r))
    const until = Date.now() + 30_000
    while (!(await page('GET', '/info')).listening) {
      assert.ok(Date.now() < until, 'the page never saw the agent listening')
      await new Promise((r) => setTimeout(r, 100))
    }

    // The person, in the page: a comment on the frame they see.
    const shown = (await page('GET', '/info')).revision
    const made = await page('POST', '/comments', {
      revision: shown,
      t: 0.5,
      box: [0, 0, 16, 16],
      text: 'too dark: make it white',
    })

    assert.equal(await heard, 0)
    const woke = JSON.parse(out).result.comments
    assert.deepEqual(
      woke.map((c: { id: string }) => c.id),
      [made.id],
    )

    // 2. Read: the open ones, oldest first.
    const [c] = (await mcp('comments', {})).comments
    assert.equal(c.id, made.id)
    // 3. Say what it starts.
    await mcp('activity_add', { text: 'making the frame white', comment: c.id })
    // 4. See what they saw: the box as region, at its t.
    const before = JSON.parse(
      (
        (await client.callTool({
          name: 'render_frame',
          arguments: { t: c.t, region: c.box },
        })) as { content: { text: string }[] }
      ).content[0]?.text as string,
    )
    used.add('render_frame')
    assert.ok(before.meanRgba[0] < 10)
    // 5. The smallest fix, check, look again.
    const file = join(root, 'src', 'composition.ts')
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('const grey = Number(params.grey)', 'const grey = 255'),
    )
    assert.deepEqual((await mcp('check', { samples: 3 })).failures, [])
    const after = JSON.parse(
      (
        (await client.callTool({
          name: 'render_frame',
          arguments: { t: c.t, region: c.box },
        })) as { content: { text: string }[] }
      ).content[0]?.text as string,
    )
    assert.ok(after.meanRgba[0] > 245)
    // 6. Reply fixed, in the person's terms.
    const replied = await mcp('comment_reply', {
      id: c.id,
      text: 'the frame is white now',
      fixed: true,
    })
    assert.equal(replied.comments[0].state, 'fixed')
    // 7. It can't resolve.
    await assert.rejects(mcp('comment_resolve', { id: c.id }), /only the person resolves/)
    // (The section names no resolve tool: it tells the agent it can't.)
    used.delete('comment_resolve')

    // The page sees it fixed in a revision, with the fix's reply and the agent's note.
    const [thread] = (await page('GET', '/comments')).filter(
      (t: { id: string }) => t.id === made.id,
    )
    assert.equal(thread.state, 'fixed')
    assert.match(thread.fixedIn, /^[0-9a-f]{16}$/)
    assert.notEqual(thread.fixedIn, thread.revision)
    const notes = (await page('GET', '/activity')).filter(
      (e: { kind: string; comment?: string }) => e.kind === 'note' && e.comment === c.id,
    )
    assert.equal(notes.length, 1)

    // Everything the agent used is named in the skill's section.
    for (const name of [...used, 'comments --wait --json'])
      assert.ok(section.includes(name), `the section names ${name}`)
  } finally {
    await client.close()
  }
})
