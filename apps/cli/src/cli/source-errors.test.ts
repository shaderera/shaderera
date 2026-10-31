import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { cli } from '../fixtures/cli.ts'
import { tempDir } from '../fixtures/temp.ts'
import { createServer } from './mcp.ts'

/** A project whose src/composition.ts is `code`. */
const film = (code: string) => {
  const root = tempDir('source-error')
  mkdirSync(join(root, 'src'))
  writeFileSync(
    join(root, 'shaderera.json'),
    JSON.stringify({ entry: './src/composition.ts', fps: 10, duration: 1, width: 8, height: 8 }),
  )
  writeFileSync(join(root, 'src', 'composition.ts'), code)
  return root
}

const renderThrows = `import type { Open } from '@shaderera/core'

const open: Open = ({ io }) => {
  const canvas = io.canvas(8, 8)
  return {
    render: async (t) => {
      if (t > 0.2) throw new Error('boom')
      return { color: canvas }
    },
  }
}

export default open
`
const openThrows = `const open = () => {
  throw new Error('no footage')
}

export default open
`
const syntax = `const open = () => ({
  render: (t: number => t,
})

export default open
`
const noExport = `export const open = () => ({ render: () => [] })
`

/** The finding of `still 0.5 --json` on a project, and the MCP render_frame error's. */
const findingsOf = async (root: string) => {
  const r = await cli('still', '0.5', '--root', root, '--out', join(root, 'out'), '--json')
  assert.equal(r.status, 2, r.stdout)
  assert.equal(r.stderr, '', 'nothing leaks to stderr under --json')
  const [finding] = JSON.parse(r.stdout).findings
  const server = createServer(root)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  try {
    const m = (await client.callTool({ name: 'render_frame', arguments: { t: 0.5 } })) as {
      content: { text: string }[]
      isError?: boolean
    }
    assert.equal(m.isError, true)
    assert.equal(m.content[0]?.text, finding.message)
    return { cli: finding, mcp: JSON.parse(m.content[1]?.text as string) }
  } finally {
    await client.close()
  }
}

test('a throw in render(t) names t and the source line, on the CLI and in MCP', async () => {
  const { cli, mcp } = await findingsOf(film(renderThrows))
  assert.deepEqual(cli, {
    code: 'error',
    severity: 'error',
    message: 'render(0.5) threw: boom (src/composition.ts:7)',
    file: 'src/composition.ts',
    line: 7,
    column: 26,
    t: [0.5],
  })
  assert.deepEqual(mcp, cli)
})

test('a throw in open() names the source line', async () => {
  const { cli, mcp } = await findingsOf(film(openThrows))
  assert.equal(cli.message, 'open() threw: no footage (src/composition.ts:2)')
  assert.deepEqual([cli.file, cli.line, cli.t], ['src/composition.ts', 2, undefined])
  assert.deepEqual(mcp, cli)
})

test('a syntax error is a build finding with its file, line and column', async () => {
  const { cli, mcp } = await findingsOf(film(syntax))
  assert.equal(cli.code, 'build')
  assert.deepEqual([cli.file, cli.line], ['src/composition.ts', 2])
  assert.equal(typeof cli.column, 'number')
  assert.match(cli.message, /─\[ src\/composition\.ts:2:\d+ \]/)
  assert.deepEqual(mcp, cli)
})

test('a missing default export names the entry and the fix', async () => {
  const { cli, mcp } = await findingsOf(film(noExport))
  assert.equal(
    cli.message,
    'src/composition.ts has no default export: end it with export default open.',
  )
  assert.deepEqual([cli.file, cli.line], ['src/composition.ts', 2])
  assert.deepEqual(mcp, cli)
})
