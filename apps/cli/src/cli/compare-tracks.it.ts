import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { cli } from '../fixtures/cli.ts'
import { tempDir } from '../fixtures/temp.ts'
import { createServer } from './mcp.ts'

/** The reference's move, as the fixture's move.ts writes it: 0 to 40 px from 0.6 s. */
const move = (t: number) => {
  const p = Math.min(1, Math.max(0, (t - 0.6) / 0.5))
  return 40 * p * p * (3 - 2 * p)
}

/**
 * The fixture film's card moves 2 frames after its reference and its dot on it, measured by an
 * inspect path and by the DOM element in the browser host. Needs Chrome (CHROME overrides).
 */
test('inspect --compare-tracks finds the card 2 frames late and the dot in step, by inspect path and by DOM element (#687)', async () => {
  const root = tempDir('compare-tracks')
  cpSync(fileURLToPath(new URL('./fixtures/tracks/', import.meta.url)), root, { recursive: true })
  writeFileSync(join(root, 'hero.mp4'), 'the reference clip')
  const times = Array.from({ length: 15 }, (_, i) => Number((0.2 + i / 10).toFixed(6)))
  const track = (element: string) => ({
    element,
    channel: 'x',
    unit: 'source-px',
    samples: times.map((t) => [t, Number(move(t).toFixed(4))]),
  })
  const tracks = (kind: string, sha256: string) =>
    JSON.stringify({
      format: 'shaderera.analysis/1',
      kind,
      source: { path: 'hero.mp4', bytes: 18, sha256 },
      tool: { script: 'tools/track.ts', version: '0.1.0' },
      params: { fps: 10 },
      frame: { width: 64, height: 36, pixelRatio: 1 },
      tracks: [track('#card'), track('#dot')],
      declared: [],
      limits: [],
    })
  const sha256 = createHash('sha256').update('the reference clip').digest('hex')
  writeFileSync(join(root, 'tracks.json'), tracks('reference-tracks', sha256))
  writeFileSync(
    join(root, 'pairs.json'),
    JSON.stringify([
      { element: '#card', channel: 'x', film: { path: 'objects[id=card].x' } },
      { element: '#dot', channel: 'x', film: { path: 'objects[id=dot].x' } },
      { element: '#card', channel: 'x', film: { id: 'card', channel: 'x' } },
      { element: '#dot', channel: 'x', film: { id: 'dot', channel: 'x' } },
    ]),
  )
  const compare = (...args: string[]) =>
    cli(
      'inspect',
      '--root',
      root,
      '--compare-tracks',
      join(root, 'tracks.json'),
      '--pairs',
      join(root, 'pairs.json'),
      ...args,
    )

  const r = await compare('--max-shift', '4', '--json')
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout).result
  assert.equal(report.pairs.length, 4)
  const [card, dot, cardDom, dotDom] = report.pairs
  for (const [p, steps] of [
    [card, -2],
    [dot, 0],
    [cardDom, -2],
    [dotDom, 0],
  ])
    assert.equal(p.offset.found?.steps, steps, JSON.stringify(p.offset))
  assert.deepEqual(cardDom.film, { id: 'card', channel: 'x' })
  assert.equal(card.window.film.first, 0.9)
  assert.equal(card.window.reference.first, 0.7)
  // The DOM draws the dot where the reference has it, within layout's rounding.
  assert.ok(dotDom.difference.max < 0.05, JSON.stringify(dotDom.difference))
  assert.ok(cardDom.difference.max > 5)

  // The human output says which way the film is off and the offset that aligns it.
  const text = await compare('--max-shift', '4')
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /#card x \(source-px\) vs data-id card x/)
  assert.match(text.stdout, /the film 2 steps later.*Aligned: --offset=-0\.2/)

  // The MCP inspect tool gives the same report, with the file inside the project.
  const server = createServer(root, {})
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(a), client.connect(b)])
  try {
    const called = (await client.callTool({
      name: 'inspect',
      arguments: { compare_tracks: 'tracks.json', pairs: 'pairs.json', max_shift: 4 },
    })) as { content: { text: string }[]; isError?: boolean }
    assert.ok(!called.isError, called.content[0]?.text)
    const viaMcp = JSON.parse(called.content[0]?.text as string)
    assert.equal(viaMcp.reference.file, 'tracks.json')
    assert.deepEqual(
      viaMcp.pairs.map((p: { offset: { found: { steps: number } } }) => p.offset.found.steps),
      [-2, 0, -2, 0],
    )
  } finally {
    await client.close()
  }

  // A refused file and a refused pair each name the reason, and exit 2.
  writeFileSync(join(root, 'style.json'), tracks('reference-style', sha256))
  const style = await cli(
    'inspect',
    '--root',
    root,
    '--compare-tracks',
    join(root, 'style.json'),
    '--pairs',
    join(root, 'pairs.json'),
  )
  assert.equal(style.status, 2)
  assert.match(style.stderr, /is a "reference-style" analysis, not reference-tracks/)
  writeFileSync(join(root, 'hero.mp4'), 'another clip')
  const changed = await compare()
  assert.equal(changed.status, 2)
  assert.match(changed.stderr, /was measured from other bytes than hero\.mp4/)
  writeFileSync(join(root, 'hero.mp4'), 'the reference clip')
  writeFileSync(
    join(root, 'pairs.json'),
    JSON.stringify([
      { element: '#card', channel: 'opacity', film: { id: 'card', channel: 'opacity' } },
    ]),
  )
  const pair = await compare()
  assert.equal(pair.status, 2)
  assert.match(pair.stderr, /has no opacity for #card: it has x/)
})
