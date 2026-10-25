import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { tempDir } from '../fixtures/temp.ts'
import type { openRevision } from '../project/jobs.ts'
import { revisionHosts } from './revision-host.ts'

type Opened = Awaited<ReturnType<typeof openRevision>>
const R = '0123456789abcdef'

/** A project with revision R's file, and an opener that counts the hosts it opened and closed. */
const setup = (idleMs?: number) => {
  const root = tempDir('revision-host')
  mkdirSync(join(root, 'versions', 'revisions'), { recursive: true })
  writeFileSync(join(root, 'versions', 'revisions', `${R}.json`), '{}')
  const n = { opened: 0, closed: 0 }
  const open = (async () => {
    n.opened++
    return { close: async () => void n.closed++ } as unknown as Opened
  }) as unknown as typeof openRevision
  return { root, n, hosts: revisionHosts({ open, ...(idleMs ? { idleMs } : {}) }) }
}

test('a kept revision host is reused, dropped after a failed call, and closed when idle', async () => {
  const { root, n, hosts } = setup(50)
  await hosts.get(root, R, undefined, undefined)
  hosts.rest()
  await hosts.get(root, R, undefined, undefined)
  assert.deepEqual(n, { opened: 1, closed: 0 })
  // A call on it failed (a lost device, say): the next call opens a new host.
  await hosts.drop()
  await hosts.get(root, R, undefined, undefined)
  assert.deepEqual(n, { opened: 2, closed: 1 })
  // Unused after its call ended: it closes by itself.
  hosts.rest()
  await sleep(150)
  assert.deepEqual(n, { opened: 2, closed: 2 })
  await hosts.get(root, R, undefined, undefined)
  assert.equal(n.opened, 3)
  await hosts.drop()
})

test('a kept host of a revision pruned since is closed, and the call says it was pruned', async () => {
  const { root, n, hosts } = setup()
  await hosts.get(root, R, undefined, undefined)
  rmSync(join(root, 'versions', 'revisions', `${R}.json`))
  writeFileSync(join(root, 'versions', 'pruned.jsonl'), `${JSON.stringify({ id: R })}\n`)
  await assert.rejects(
    hosts.get(root, R, undefined, undefined),
    new RegExp(`Revision ${R} was pruned`),
  )
  assert.deepEqual(n, { opened: 1, closed: 1 })
})
