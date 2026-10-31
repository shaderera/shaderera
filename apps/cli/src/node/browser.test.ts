import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { tempDir } from '../fixtures/temp.ts'
import { browserAdapter, claimProfile } from './browser.ts'

test('one host holds the project profile; a stale lock is taken over; release frees only its own', () => {
  const root = tempDir('profile')
  const lock = join(root, '.shaderera', 'chrome.lock')
  const own = join(root, '.shaderera', 'chrome')

  // A lock left by a process that has exited is taken over.
  mkdirSync(join(root, '.shaderera'))
  writeFileSync(lock, '999999999')
  const first = claimProfile(root)
  assert.equal(first.profile, own)
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid))

  // While it is held, a second host gets a throwaway profile and leaves the lock alone.
  const second = claimProfile(root)
  assert.notEqual(second.profile, own)
  second.release()
  assert.equal(existsSync(second.profile), false)
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid))

  // Another process holds the lock now (it took it over): the first host's release keeps it.
  writeFileSync(lock, String(process.ppid))
  first.release()
  assert.equal(readFileSync(lock, 'utf8'), String(process.ppid))

  // Released by its holder, it is free again.
  writeFileSync(lock, String(process.pid))
  first.release()
  assert.equal(existsSync(lock), false)
  const third = claimProfile(root)
  assert.equal(third.profile, own)
  third.release()
})

test('a Chrome that cannot start is an error that says so, not a crash', async () => {
  const missing = join(tempDir('chrome'), 'chrome.exe')
  const started = Date.now()
  await assert.rejects(browserAdapter(missing), /it could not start \(spawn .*ENOENT\)/)
  assert.ok(Date.now() - started < 5000, 'without waiting for a DevTools port')
})
