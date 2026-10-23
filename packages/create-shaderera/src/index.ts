import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { create, projectDir } from './create.ts'

const here = import.meta.dirname
const { version } = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
const usage = `Usage: npm create shaderera@latest [dir]
       create-shaderera [dir] [--help]

Makes an empty Shaderera project in dir (default my-film): render(t) in src/composition.ts,
shaderera.json, AUTHORING.md, guides/, AGENTS.md / CLAUDE.md and .mcp.json.

  dir                                        the new project's folder; it must be empty or missing
  -h, --help                                 print this usage

Docs: https://github.com/shaderera/shaderera/tree/main/packages/create-shaderera, and after
npm install, AUTHORING.md and node_modules/shaderera/docs/.`

const args = (() => {
  try {
    return parseArgs({ allowPositionals: true, options: { help: { type: 'boolean', short: 'h' } } })
  } catch (error) {
    const flag = /'([^']+)'/.exec((error as Error).message)?.[1] ?? (error as Error).message
    console.error(`Unknown option: ${flag}. See create-shaderera --help.`)
    process.exit(2)
  }
})()
if (args.values.help) {
  console.log(usage)
  process.exit(0)
}
const files = join(here, '..', 'files')
const packed = existsSync(join(files, 'AUTHORING.md'))
const repo = join(here, '..', '..', '..')
const guides = {
  'AUTHORING.md': packed ? join(files, 'AUTHORING.md') : join(repo, 'docs', 'authoring.md'),
  'AGENTS.md': join(here, '..', 'guide', 'AGENTS.md'),
  'CLAUDE.md': join(here, '..', 'guide', 'CLAUDE.md'),
  // No skills: the Claude Code plugin or `npx skills add` installs them once, and updates them.
  guides: packed ? join(files, 'guides') : join(repo, 'docs', 'guides'),
}
const target = args.positionals[0] ?? 'my-film'
// `.` or the current folder's own path: the project is made here, so there is no cd.
const inPlace = resolve(target) === process.cwd()

let name: string
try {
  name = create({ from: projectDir(here), target, version, guides })
} catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}
const cd = inPlace ? '' : `  cd ${target}\n`
console.log(`Created ${inPlace ? `${name} here` : target}. Next:

${cd}  npm install
  npx shaderera check
  npx shaderera still 0 5 --sheet

The film is render(t) in src/composition.ts. AUTHORING.md is the workflow, guides/ the focused
references, node_modules/shaderera/docs/ the reference.`)
