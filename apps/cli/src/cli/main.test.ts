import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { closest, usageOf } from './main.ts'

const main = fileURLToPath(new URL('./main.ts', import.meta.url))
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [main, ...args], { encoding: 'utf8' })

test('a mistyped command says it is unknown on stderr, with the nearest command, and exits 2', () => {
  const r = cli('stil', '1')
  assert.equal(r.status, 2)
  assert.match(r.stderr, /Unknown command: stil\. Did you mean still\?/)
  assert.equal(r.stdout, '')
  assert.doesNotMatch(cli('xyzzy').stderr, /Did you mean/)
})

test('help <command> and <command> --help print that command, help alone all of it', () => {
  for (const args of [
    ['help', 'studio'],
    ['studio', '--help'],
  ]) {
    const r = cli(...args)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^ {2}studio \[--connect id\]/)
    assert.doesNotMatch(r.stdout, /inspect/)
  }
  const all = cli('help')
  assert.equal(all.status, 0)
  assert.match(all.stdout, /^Usage: shaderera <command>/)
  assert.match(all.stdout, /inspect/)
  assert.equal(cli('help', 'nope').status, 2)
})

test('usageOf keeps every line of a command; closest stays within two edits', () => {
  assert.equal(usageOf('plan').split('\n').length, 2)
  assert.match(usageOf(), /^Usage:/)
  assert.equal(closest('chek'), 'check')
  assert.equal(closest('render'), 'render')
  assert.equal(closest('zzzzzz'), undefined)
})
