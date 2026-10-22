import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { claim, readClaim, removePartials, STALE_MS } from './claim.ts'

/** The pid of a process that ran and is gone. */
const dead = () => spawnSync(process.execPath, ['-e', '']).pid as number

const claimFile = (dir: string, c: object) =>
  writeFileSync(join(dir, 'chunk-000.mkv.claim'), JSON.stringify({ at: 'then', ...c }))

test('a claimed chunk is refused to a second render, and free again once released', () => {
  const dir = tempDir('claim')
  const first = claim(dir, 'chunk-000.mkv')
  assert.ok(first.ours())
  assert.throws(
    () => claim(dir, 'chunk-000.mkv'),
    new RegExp(`chunk-000\\.mkv is being rendered by ${hostname()} \\(pid ${process.pid}, since `),
  )
  first.release()
  assert.equal(existsSync(join(dir, 'chunk-000.mkv.claim')), false)
  claim(dir, 'chunk-000.mkv').release()
})

test('a stale claim is taken over: a dead process of this machine, or untouched for too long', () => {
  const dir = tempDir('claim-stale')
  claimFile(dir, { host: hostname(), pid: dead() })
  assert.equal(readClaim(dir, 'chunk-000.mkv')?.live, false)
  const taken = claim(dir, 'chunk-000.mkv')
  assert.ok(taken.ours())
  taken.release()
  // Another machine's claim: its pid cannot be asked, its age decides.
  claimFile(dir, { host: 'elsewhere', pid: 1 })
  assert.throws(() => claim(dir, 'chunk-000.mkv'), /being rendered by elsewhere \(pid 1/)
  const old = new Date(Date.now() - STALE_MS - 1000)
  utimesSync(join(dir, 'chunk-000.mkv.claim'), old, old)
  claim(dir, 'chunk-000.mkv').release()
  // A claim cut short as it was written holds until it is stale.
  writeFileSync(join(dir, 'chunk-000.mkv.claim'), '{"host":')
  assert.equal(readClaim(dir, 'chunk-000.mkv')?.live, true)
})

test("partials of dead renders go; a live render's stay, unless the chunk is claimed", () => {
  const dir = tempDir('partials')
  const out = join(dir, 'film.mp4')
  const gone = dead()
  for (const pid of [gone, process.pid, process.ppid])
    writeFileSync(`${out}.${pid}.partial`, 'part')
  writeFileSync(join(dir, 'film.mp4.json'), '{}')
  removePartials(out, '.partial')
  assert.deepEqual(
    readdirSync(dir).sort(),
    [`film.mp4.${process.pid}.partial`, `film.mp4.${process.ppid}.partial`, 'film.mp4.json'].sort(),
  )
  removePartials(out, '.partial', true)
  assert.deepEqual(readdirSync(dir).sort(), [`film.mp4.${process.pid}.partial`, 'film.mp4.json'])
})
