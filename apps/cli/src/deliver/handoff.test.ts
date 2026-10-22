import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { shareFiles } from '../cli/share.ts'
import { tempDir } from '../fixtures/temp.ts'
import { createJob } from '../project/jobs.ts'
import { writeHandoff } from './handoff.ts'

test('files that hold secrets are in no revision, so neither a share nor a handoff carries one', async () => {
  const root = tempDir('handoff-secrets')
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

test('an .mcp.json without keys is sent like any file; one that gives a server env or headers is a secret', () => {
  const root = tempDir('mcp-json')
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  const plain = { mcpServers: { shaderera: { command: 'npx', args: ['shaderera', 'mcp'] } } }
  writeFileSync(join(root, '.mcp.json'), JSON.stringify(plain))
  let shared = shareFiles(root)
  assert.ok('.mcp.json' in shared.files)
  assert.deepEqual(shared.secrets, [])
  // An empty env is no key either.
  plain.mcpServers.shaderera = { ...plain.mcpServers.shaderera, env: {} } as never
  writeFileSync(join(root, '.mcp.json'), JSON.stringify(plain))
  assert.ok('.mcp.json' in shareFiles(root).files)
  for (const keyed of [
    { mcpServers: { x: { command: 'x', env: { API_KEY: 'never-leaves' } } } },
    {
      mcpServers: {
        x: { type: 'http', url: 'https://x.example', headers: { Authorization: 'k' } },
      },
    },
  ]) {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify(keyed))
    shared = shareFiles(root)
    assert.deepEqual(shared.secrets, ['.mcp.json'])
    assert.equal('.mcp.json' in shared.files, false)
  }
})
