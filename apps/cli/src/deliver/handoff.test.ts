import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { shareFiles } from '../cli/share.ts'
import { createJob } from '../project/jobs.ts'
import { writeHandoff } from './handoff.ts'

test('files that hold secrets are in no revision, so neither a share nor a handoff carries one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shaderera-handoff-secrets-'))
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  const secrets = ['.dev.vars', '.envrc', '.mcp.json', '.npmrc', 'keys/key.pem']
  mkdirSync(join(root, 'keys'))
  for (const f of secrets) writeFileSync(join(root, f), 'TOKEN=never-leaves')
  const shared = shareFiles(root)
  assert.deepEqual(shared.secrets.sort(), [...secrets].sort())
  for (const f of secrets) assert.equal(f in shared.files, false, f)
  const job = await createJob(root, { by: 'cli', name: 's' })
  const { dir } = writeHandoff(root, job)
  assert.ok(existsSync(join(dir, 'shaderera.json')))
  for (const f of secrets) assert.equal(existsSync(join(dir, f)), false, f)
})
