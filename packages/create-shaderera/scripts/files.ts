/**
 * Build step: copy what every new project gets into `files/`: the starting project, the authoring
 * guide (docs/authoring.md) as `AUTHORING.md`, the focused guides (docs/guides) as `guides/`, and
 * the agent skills (plugins/shaderera/skills).
 */
import { copyFileSync, cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { copyProject } from '../src/create.ts'

const here = join(import.meta.dirname, '..')
const repo = join(here, '..', '..')
const out = join(here, 'files')
rmSync(out, { recursive: true, force: true })
copyProject(join(here, 'project'), join(out, 'project'))
copyFileSync(join(repo, 'docs', 'authoring.md'), join(out, 'AUTHORING.md'))
cpSync(join(repo, 'docs', 'guides'), join(out, 'guides'), { recursive: true })
cpSync(join(repo, 'plugins', 'shaderera', 'skills'), join(out, 'skills'), { recursive: true })
