import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { create, projectDir } from './create.ts'

const here = import.meta.dirname
const { version } = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const { positionals } = parseArgs({ allowPositionals: true, options: {} })
const files = join(here, '..', 'files')
const packed = existsSync(join(files, 'AUTHORING.md'))
const repo = join(here, '..', '..', '..')
const skills = packed ? join(files, 'skills') : join(repo, 'plugins', 'shaderera', 'skills')
const guides = {
  'AUTHORING.md': packed ? join(files, 'AUTHORING.md') : join(repo, 'docs', 'authoring.md'),
  'AGENTS.md': join(here, '..', 'guide', 'AGENTS.md'),
  'CLAUDE.md': join(here, '..', 'guide', 'CLAUDE.md'),
  guides: packed ? join(files, 'guides') : join(repo, 'docs', 'guides'),
  // The agent skills, the same as the Claude Code plugin's: making a film, and its add-ons.
  '.claude/skills/shaderera': join(skills, 'shaderera'),
  '.claude/skills/shaderera-addons': join(skills, 'shaderera-addons'),
}
const target = positionals[0] ?? 'my-film'

try {
  create({ from: projectDir(here), target, version, guides })
} catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}
console.log(`Created ${target}. Next:

  cd ${target}
  npm install
  npx shaderera check
  npx shaderera still 0 5 --sheet

The film is render(t) in src/composition.ts. AUTHORING.md is the workflow, guides/ the focused
references, node_modules/shaderera/docs/ the reference.`)
