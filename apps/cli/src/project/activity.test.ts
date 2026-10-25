import assert from 'node:assert/strict'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { IMAGES, ROTATE, record, recordCommand, redact, summaryOf, tail } from './activity.ts'

const png = (n = 8) => new Uint8Array(n).fill(7)

test('record appends an entry with its id, time and author; tail reads them back in order', () => {
  const root = tempDir('activity')
  const a = record(root, { by: 'cli', kind: 'note', text: 'first' })
  const b = record(root, { by: 'agent', kind: 'note', text: 'second', comment: 'c1' })
  assert.ok(a && b)
  assert.match(a.id, /^[0-9a-z]+-[0-9a-f]+$/)
  assert.ok(Date.parse(a.at) > 0)
  assert.deepEqual(
    tail(root, 10).map((e) => [e.by, e.kind === 'note' && e.text]),
    [
      ['cli', 'first'],
      ['agent', 'second'],
    ],
  )
  assert.equal(tail(root, 1)[0]?.id, b.id)
  // A torn last line (a writer stopped halfway) is skipped.
  appendFileSync(join(root, '.shaderera', 'activity.jsonl'), '{"id":"torn","at":')
  assert.equal(tail(root, 10).length, 2)
})

test("an entry's image is kept under .shaderera/activity/, named by the entry", () => {
  const root = tempDir('activity')
  const e = record(root, { by: 'agent', kind: 'tool', tool: 'still', ok: true, ms: 1 }, png())
  assert.ok(e?.image)
  assert.equal(e.image, `.shaderera/activity/${e.id}.png`)
  assert.equal(statSync(join(root, e.image)).size, 8)
  // An image over the cap is left out, the entry kept.
  const big = record(
    root,
    { by: 'agent', kind: 'note', text: 'x' },
    new Uint8Array(IMAGES.bytes + 1),
  )
  assert.ok(big)
  assert.equal(big.image, undefined)
})

test('rotation keeps the log at 2 MB or less, and prunes the images it drops', () => {
  const root = tempDir('activity')
  const text = 'x'.repeat(2000)
  let first: string | undefined
  for (let i = 0; i < 1600; i++) {
    const e = record(root, { by: 'cli', kind: 'note', text }, i % 100 === 0 ? png() : undefined)
    first ??= e?.image
  }
  const dir = join(root, '.shaderera')
  const size = (f: string) => (existsSync(join(dir, f)) ? statSync(join(dir, f)).size : 0)
  assert.ok(size('activity.jsonl') <= ROTATE)
  assert.ok(size('activity.1.jsonl') <= ROTATE)
  assert.ok(size('activity.jsonl') + size('activity.1.jsonl') <= 2 * ROTATE)
  assert.ok(existsSync(join(dir, 'activity.1.jsonl')))
  // The first entries went with the older file, and their image with them.
  assert.ok(first)
  assert.equal(existsSync(join(root, first)), false)
  for (const e of tail(root, 2000)) if (e.image) assert.ok(existsSync(join(root, e.image)))
})

test('at most IMAGES.count images are kept: the oldest go first', () => {
  const root = tempDir('activity')
  for (let i = 0; i < IMAGES.count + 5; i++)
    record(root, { by: 'cli', kind: 'note', text: `${i}` }, png())
  assert.equal(readdirSync(join(root, '.shaderera', 'activity')).length, IMAGES.count)
  const kept = tail(root, 1000).filter((e) => e.image && existsSync(join(root, e.image)))
  assert.equal(kept.length, IMAGES.count)
  assert.equal(kept[0]?.kind === 'note' && kept[0].text, '5')
})

test('a write that fails gives undefined, never a throw; a torn last line is skipped', () => {
  const root = tempDir('activity')
  // The log a folder: every append fails.
  mkdirSync(join(root, '.shaderera', 'activity.jsonl'), { recursive: true })
  assert.equal(record(root, { by: 'cli', kind: 'note', text: 'lost' }, png()), undefined)
  assert.deepEqual(tail(root, 5), [])
  assert.deepEqual(readdirSync(join(root, '.shaderera', 'activity')), [])
})

test('a summary is the counts by severity and the first three messages', () => {
  const f = (severity: 'error' | 'warning' | 'info', message: string) => ({
    code: 'x',
    severity,
    message,
  })
  assert.deepEqual(
    summaryOf([f('error', 'a'), f('warning', 'b'), f('warning', 'c'), f('info', 'd')]),
    { error: 1, warning: 2, info: 1, messages: ['a', 'b', 'c'] },
  )
  assert.deepEqual(summaryOf([]), { error: 0, warning: 0, info: 0, messages: [] })
  assert.equal(summaryOf([f('error', 'y'.repeat(1000))]).messages[0]?.length, 300)
})

test('secrets stay out: credential-like flags are redacted, login and logout never recorded', () => {
  assert.deepEqual(
    redact([
      '--token',
      'abc',
      '--api-key=k1',
      '--SECRET',
      's',
      '--password',
      'p',
      '--passphrase=q',
      '--keep',
      '10',
      '--root',
      'r',
      'check',
    ]),
    [
      '--token',
      '***',
      '--api-key=***',
      '--SECRET',
      '***',
      '--password',
      '***',
      '--passphrase=***',
      '--keep',
      '10',
      '--root',
      'r',
      'check',
    ],
  )
  // auth, bearer and credential flags; a URL's user and password, wherever it is.
  assert.deepEqual(
    redact([
      '--auth',
      'a',
      '--bearer=b',
      '--credentials',
      'c',
      'https://user:pa55@host.example/x',
      '--api=https://me@api.example',
      'https://host.example/@me',
    ]),
    [
      '--auth',
      '***',
      '--bearer=***',
      '--credentials',
      '***',
      'https://***@host.example/x',
      '--api=https://***@api.example',
      'https://host.example/@me',
    ],
  )
  // A flag with no value (a boolean) leaves the next flag alone.
  assert.deepEqual(redact(['--token', '--json']), ['--token', '--json'])
  const root = tempDir('activity')
  writeFileSync(join(root, 'shaderera.json'), '{}')
  for (const command of ['login', 'logout'])
    recordCommand({
      argv: [command, '--token', 't0k3n', '--root', root],
      exitCode: 0,
      findings: [],
    })
  recordCommand({ argv: ['share', '--token=t0k3n', '--root', root], exitCode: 0, findings: [] })
  const entries = tail(root, 10)
  assert.equal(entries.length, 1)
  assert.ok(entries[0]?.kind === 'command')
  assert.deepEqual(entries[0].args, ['--token=***', '--root', root])
  assert.equal(
    readFileSync(join(root, '.shaderera', 'activity.jsonl'), 'utf8').includes('t0k3n'),
    false,
  )
})

test('an image no entry names (a rotation raced by another process) goes at the next rotation, once a minute old', () => {
  const root = tempDir('activity')
  const images = join(root, '.shaderera', 'activity')
  mkdirSync(images, { recursive: true })
  const orphan = join(images, 'orphan.png')
  const fresh = join(images, 'fresh.png')
  writeFileSync(orphan, png())
  writeFileSync(fresh, png())
  const old = new Date(Date.now() - 120_000)
  utimesSync(orphan, old, old)
  const text = 'x'.repeat(2000)
  for (let i = 0; i < 600; i++) record(root, { by: 'cli', kind: 'note', text })
  assert.ok(existsSync(join(root, '.shaderera', 'activity.1.jsonl')))
  assert.equal(existsSync(orphan), false)
  assert.equal(existsSync(fresh), true)
})
