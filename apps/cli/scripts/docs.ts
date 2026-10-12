/**
 * Build step: copy the monorepo's reference docs into `docs/` and its focused guides into
 * `guides/`, so the published package carries both (decision 0011: an installed project reads
 * them in `node_modules/shaderera/`, not on GitHub).
 */
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const cli = join(import.meta.dirname, '..')
const docs = join(cli, '..', '..', 'docs')
/** Working notes of this repository, not references for a project. */
const SKIP = new Set(['README.md', 'releasing.md'])

const out = join(cli, 'docs')
rmSync(out, { recursive: true, force: true })
for (const f of readdirSync(docs))
  if (f.endsWith('.md') && !SKIP.has(f)) cpSync(join(docs, f), join(out, f))
cpSync(join(docs, 'participants'), join(out, 'participants'), { recursive: true })

const guides = join(docs, 'guides')
rmSync(join(cli, 'guides'), { recursive: true, force: true })
if (existsSync(guides)) cpSync(guides, join(cli, 'guides'), { recursive: true })
