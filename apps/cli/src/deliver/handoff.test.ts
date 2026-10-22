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

test("a new project's .mcp.json is sent like any file; any other MCP config is a secret", () => {
  const root = tempDir('mcp-json')
  cpSync(fileURLToPath(new URL('../cli/fixtures/deliver/', import.meta.url)), root, {
    recursive: true,
  })
  const own = (server: object) => JSON.stringify({ mcpServers: { shaderera: server } })
  const template = { command: 'npx', args: ['-y', 'shaderera', 'mcp'] }
  for (const sent of [
    own(template),
    own({ command: 'npx', args: ['-y', 'shaderera@0.1.5', 'mcp'] }),
    own({ ...template, env: {}, headers: {} }),
  ]) {
    writeFileSync(join(root, '.mcp.json'), sent)
    const shared = shareFiles(root)
    assert.ok('.mcp.json' in shared.files, sent)
    assert.deepEqual(shared.secrets, [])
  }
  for (const kept of [
    own({ ...template, env: { API_KEY: 'never-leaves' } }),
    own({ ...template, headers: { Authorization: 'never-leaves' } }),
    own({ command: 'npx', args: ['-y', 'shaderera', 'mcp', '--api-key', 'sk-never-leaves'] }),
    own({ command: 'npx', args: ['-y', 'other-server', 'mcp'] }),
    own({ type: 'http', url: 'https://x.example/mcp?token=never-leaves' }),
    own({ type: 'http', url: 'https://user:never-leaves@x.example/mcp' }),
    own({ ...template, token: 'never-leaves' }),
    JSON.stringify({ mcpServers: { shaderera: template }, apiKey: 'never-leaves' }),
    '{ not json',
  ]) {
    writeFileSync(join(root, '.mcp.json'), kept)
    const shared = shareFiles(root)
    assert.deepEqual(shared.secrets, ['.mcp.json'], kept)
    assert.equal('.mcp.json' in shared.files, false, kept)
  }
})
