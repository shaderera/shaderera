import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { COMMON, helpOf } from './main.ts'

const repo = join(import.meta.dirname, '..', '..', '..', '..')
const read = (...p: string[]) => readFileSync(join(repo, ...p), 'utf8')

/**
 * The guides copied into every project and the skill name commands an agent runs as written: each
 * command and flag they name must be one docs/cli.md documents, spelled the same.
 */
test('every shaderera command and flag the authoring guide, the guides and the skill name is in docs/cli.md and in its --help', async () => {
  const cli = read('docs', 'cli.md')
  const docs = {
    'docs/authoring.md': read('docs', 'authoring.md'),
    'plugins/shaderera/skills/shaderera/SKILL.md': read(
      'plugins',
      'shaderera',
      'skills',
      'shaderera',
      'SKILL.md',
    ),
    ...Object.fromEntries(
      readdirSync(join(repo, 'docs', 'guides')).map((f) => [
        `docs/guides/${f}`,
        read('docs', 'guides', f),
      ]),
    ),
  }
  const unknown: string[] = []
  const unhelped: string[] = []
  // As cli.md writes a flag: after a space, a backtick or a bracket, and whole.
  const has = (text: string, flag: string) => new RegExp(`[\\s\`[(]${flag}(?![\\w-])`).test(text)
  for (const [file, text] of Object.entries(docs))
    for (const [, command = '', rest] of text.matchAll(/npx shaderera ([a-z]+)([^`\n#]*)/g)) {
      if (!cli.includes(`\`${command}`)) unknown.push(`${file}: shaderera ${command}`)
      const help = `${await helpOf(command)}\n${COMMON}`
      for (const [flag] of (rest ?? '').matchAll(/--[a-z][a-z0-9-]*/g)) {
        if (!has(cli, flag)) unknown.push(`${file}: shaderera ${command} ${flag}`)
        if (!has(help, flag)) unhelped.push(`${file}: shaderera ${command} ${flag}`)
      }
    }
  assert.deepEqual(unknown, [], 'in docs/cli.md')
  assert.deepEqual(unhelped, [], "in the command's --help")
})
