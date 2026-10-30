import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { tempDir } from '../fixtures/temp.ts'
import { errorFinding } from './findings.ts'
import { checkFindings } from './review.ts'

const main = fileURLToPath(new URL('./main.ts', import.meta.url))
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [main, ...args], { encoding: 'utf8' })
const envelope = (r: { stdout: string }) => JSON.parse(r.stdout)

test('--json: one envelope on stdout; 2 when the command cannot run', () => {
  const r = cli('bogus', '--json')
  assert.equal(r.status, 2)
  const e = envelope(r)
  assert.equal(e.shaderera, 'result/1')
  assert.equal(e.ok, false)
  assert.equal(e.exitCode, 2)
  assert.deepEqual(e.findings, [
    { code: 'usage', severity: 'error', message: 'Unknown command: bogus' },
  ])
})

test('--json review: its report as result, a declared rule that fails as an error finding, exit 1', () => {
  const root = tempDir('envelope')
  cpSync(fileURLToPath(new URL('./fixtures/mcp/', import.meta.url)), root, { recursive: true })
  writeFileSync(join(root, 'requirements.json'), JSON.stringify({ version: 1, endHold: 60 }))
  const r = cli('review', '--root', root, '--quick', '--json')
  assert.equal(r.status, 1, r.stderr)
  const e = envelope(r)
  assert.equal(e.exitCode, 1)
  assert.ok(Array.isArray(e.result.checks), 'the review report is the result')
  const hold = e.findings.find((f: { code: string }) => f.code === 'end-hold')
  assert.equal(hold.severity, 'error')
  assert.ok(
    e.findings.every(
      (f: { code: string; severity: string }) => f.severity !== 'error' || f.code === 'end-hold',
    ),
  )
})

test('findings carry where a check is about, and a shader error its file and line', () => {
  const [f] = checkFindings([
    {
      id: 'text-fit',
      title: 'text inside safe area',
      status: 'fail',
      where: [{ id: 'title (bottom)', t: 1.5, box: [10, 1800, 900, 120] }],
    },
  ])
  assert.deepEqual(f, {
    code: 'text-fit',
    severity: 'error',
    message: 'text inside safe area: title (bottom)',
    t: [1.5],
    bbox: [10, 1800, 900, 120],
  })
  assert.deepEqual(checkFindings([{ id: 'x', title: 'x', status: 'pass' }]), [])
  const shader = errorFinding(
    new Error('WGSL error in shader "ramp" at 3:5 (src/ramp.wgsl:3): unresolved value'),
  )
  assert.deepEqual([shader.code, shader.file, shader.line], ['shader', 'src/ramp.wgsl', 3])
})

test('--json review --quick of a clean film: what does not apply is info, never a warning', () => {
  const root = tempDir('envelope')
  cpSync(fileURLToPath(new URL('./fixtures/mcp/', import.meta.url)), root, { recursive: true })
  const r = cli('review', '--root', root, '--quick', '--json')
  assert.equal(r.status, 0, r.stderr)
  const { findings } = envelope(r)
  assert.ok(findings.length > 0, 'the checks that do not apply are still reported')
  assert.deepEqual(
    findings.filter((f: { severity: string }) => f.severity !== 'info'),
    [],
  )
})
