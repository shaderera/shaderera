// Runs a test command with the system temp folder pointed at a new folder of the run's own, fails
// if the run left a shaderera-* folder in it, then removes it with whatever Chrome put there. A
// folder of its own, not a count of the shared temp folder: other sessions make and remove theirs
// there at the same time.
//   node scripts/test-temp.ts <command...>
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'shaderera-test-run-'))
// Ctrl-C reaches the tests too: wait for them to stop, then clean up.
process.on('SIGINT', () => {})
const run = spawnSync(process.argv.slice(2).join(' '), {
  shell: true,
  stdio: 'inherit',
  env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp },
})
const left = readdirSync(temp).filter((name) => name.startsWith('shaderera-'))
if (left.length)
  console.error(
    `\nThe tests left ${left.length} temp folder(s); each test removes what it makes:\n${left.map((name) => `  ${name}`).join('\n')}`,
  )
try {
  rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
} catch (error) {
  console.error(`Could not remove ${temp} (${String(error)}); delete it later.`)
}
process.exitCode = run.status ?? 1
if (left.length) process.exitCode = 1
