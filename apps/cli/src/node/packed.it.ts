import assert from 'node:assert/strict'
import { type SpawnSyncReturns, spawnSync } from 'node:child_process'
import { cpSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'

/**
 * The browser host as a user gets it: `shaderera` and `@shaderera/core` packed, installed with npm
 * in a project outside the repository (docs/releasing.md), where the runner is the package's dist/
 * inside node_modules (#198). Needs the built packages (test:slow builds), npm's registry for vite,
 * and Chrome (CHROME overrides).
 */
const cli = fileURLToPath(new URL('../..', import.meta.url))
const core = join(cli, '../../packages/core')
const dir = tempDir('packed')
const project = join(dir, 'film')

const TIMEOUT = 300_000
const output = (r: SpawnSyncReturns<string>) => ({
  ...r,
  out: `${r.stdout}\n${r.stderr}`,
})
/** pnpm and npm, .cmd files on Windows, through the shell. */
const sh = (line: string, cwd: string) =>
  output(spawnSync(line, { cwd, encoding: 'utf8', shell: true, timeout: TIMEOUT }))

test.before(() => {
  for (const pkg of [core, cli]) {
    const r = sh(`pnpm pack --pack-destination ${JSON.stringify(dir)}`, pkg)
    assert.equal(r.status, 0, r.out)
  }
  const tarballs = readdirSync(dir).filter((f) => f.endsWith('.tgz'))
  assert.equal(tarballs.length, 2)
  cpSync(join(import.meta.dirname, 'fixtures', 'tiny'), project, { recursive: true })
  writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  const r = sh(`npm install --no-audit --no-fund vite@8.3.5 ../${tarballs.join(' ../')}`, project)
  assert.equal(r.status, 0, r.out)
})

const shaderera = (...args: string[]) =>
  output(
    spawnSync(
      process.execPath,
      ['node_modules/shaderera/bin/shaderera.js', ...args, '--host', 'browser'],
      { cwd: project, encoding: 'utf8', timeout: TIMEOUT },
    ),
  )

test('check and still run in the browser host from the installed package', () => {
  const check = shaderera('check')
  assert.equal(check.status, 0, check.out)
  assert.match(check.out, /deterministic/)
  const still = shaderera('still', '0.5')
  assert.equal(still.status, 0, still.out)
})

test('a runner worker that fails to load fails the command at once, not at the timeout', () => {
  // The worker's image decoder no longer parses: the worker module fails to load.
  writeFileSync(join(project, 'node_modules/shaderera/dist/runner/image.js'), 'export const = ;\n')
  // Chrome's profile would serve the module from its cache, as the test before loaded it.
  rmSync(join(project, '.shaderera'), { recursive: true, force: true })
  const started = Date.now()
  const check = shaderera('check')
  assert.notEqual(check.status, 0, check.out)
  assert.match(check.out, /runner worker failed to load/)
  assert.ok(Date.now() - started < 120_000, `took ${Date.now() - started} ms`)
})
