import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { create, projectDir } from './create.ts'

const from = projectDir(import.meta.dirname)
const repo = join(import.meta.dirname, '..', '..', '..')
const guides = {
  'AUTHORING.md': join(repo, 'docs', 'authoring.md'),
  'AGENTS.md': join(import.meta.dirname, '..', 'guide', 'AGENTS.md'),
  'CLAUDE.md': join(import.meta.dirname, '..', 'guide', 'CLAUDE.md'),
  guides: join(repo, 'docs', 'guides'),
  '.claude/skills/shaderera': join(repo, 'plugins', 'shaderera', 'skills', 'shaderera'),
  '.claude/skills/shaderera-registry': join(
    repo,
    'plugins',
    'shaderera',
    'skills',
    'shaderera-registry',
  ),
}

test('create copies the empty project as an ordinary project', () => {
  const target = join(mkdtempSync(join(tmpdir(), 'create-shaderera-')), 'my-film')
  create({ from, target, version: '0.1.0' })
  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'my-film')
  assert.equal(pkg.dependencies['@shaderera/core'], '^0.1.0')
  assert.equal(pkg.devDependencies.shaderera, '^0.1.0')
  assert.equal(pkg.devDependencies.webgpu, '0.6.2')
  assert.equal(pkg.devDependencies.three, undefined)
  assert.ok(existsSync(join(target, 'shaderera.json')))
  assert.ok(existsSync(join(target, 'src', 'composition.ts')))
  assert.ok(!existsSync(join(target, 'node_modules')))
  assert.match(readFileSync(join(target, '.gitignore'), 'utf8'), /^node_modules\/$/m)
  assert.throws(() => create({ from, target, version: '0.1.0' }), /not empty/)
})

test('every created project gets the authoring guide, the agent notes, the guides and the skill', () => {
  const target = join(mkdtempSync(join(tmpdir(), 'create-shaderera-')), 'film')
  create({ from, target, version: '0.3.0', guides })
  assert.match(readFileSync(join(target, 'CLAUDE.md'), 'utf8'), /@AGENTS.md/)
  assert.match(readFileSync(join(target, 'guides', 'typography.md'), 'utf8'), /^# Typography/)
  assert.match(readFileSync(join(target, 'AUTHORING.md'), 'utf8'), /^# Authoring a Shaderera film/)
  assert.match(readFileSync(join(target, 'AGENTS.md'), 'utf8'), /read `AUTHORING.md`/)
  assert.match(
    readFileSync(join(target, '.claude', 'skills', 'shaderera', 'SKILL.md'), 'utf8'),
    /^---\r?\nname: shaderera\r?\n/,
  )
  assert.match(
    readFileSync(join(target, '.claude', 'skills', 'shaderera-registry', 'SKILL.md'), 'utf8'),
    /^---\r?\nname: shaderera-registry\r?\n/,
  )
  assert.equal(
    JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).devDependencies[
      '@shaderera/registry'
    ],
    '^0.3.0',
  )
})

test('the empty project imports only the stable entries (docs/api.md), and no look', () => {
  const allowed = new Set(['@shaderera/core', '@shaderera/core/gpu'])
  const wrong: string[] = []
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|tsx|js|jsx|mts)$/.test(entry.name))
        for (const [, spec] of readFileSync(path, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g))
          if (!allowed.has(spec as string)) wrong.push(`${path}: ${spec}`)
    }
  }
  walk(join(from, 'src'))
  assert.deepEqual(wrong, [])
})
