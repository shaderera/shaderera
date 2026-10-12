import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyHandoff, writeHandoff } from '../deliver/handoff.ts'
import { findProject } from '../node/project.ts'
import { readJob } from '../project/jobs.ts'
import { childOptions, parseWithPositionals } from './args.ts'

/**
 * `shaderera handoff <job> [--verify] [--clean-install]`: writes the frozen handoff to
 * out/handoff/<job>/ and says whether it is reproducible from a clean install. --verify renders it
 * in a fresh temp folder against this project's node_modules (relocation) and compares frame
 * hashes with the project's; --clean-install runs the lock file's install there instead (the
 * check for handing it to someone else).
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values: v, positionals } = parseWithPositionals(argv, {
    verify: { type: 'boolean' },
    'clean-install': { type: 'boolean' },
    trusted: { type: 'boolean' },
    timeout: { type: 'string' },
  })
  const name = positionals[0]
  if (!name) throw new Error('Usage: shaderera handoff <job> [--verify] [--clean-install]')
  const { root } = await findProject(typeof v.root === 'string' ? v.root : process.cwd())
  const job = readJob(root, name)
  const { dir, reproducible, reasons } = writeHandoff(root, job)
  console.log(dir)
  console.log(
    reproducible
      ? 'reproducible from a clean install: yes (lock file, no local-only dependencies)'
      : `reproducible from a clean install: NO — ${reasons.join('; ')}`,
  )
  const clean = v['clean-install'] === true
  if (!v.verify && !clean) return 0
  const scope = clean
    ? 'from a clean install of its lock file in a fresh folder'
    : "in a fresh folder against this project's node_modules (relocation; not a clean install)"
  let r: Awaited<ReturnType<typeof verifyHandoff>> | undefined
  let error: string | undefined
  try {
    r = await verifyHandoff(root, job, dir, {
      ...childOptions(v),
      install: clean ? 'clean' : 'link',
    })
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  for (const f of r?.frames ?? [])
    console.log(
      `${f.same ? '✓' : '✗'} t=${f.t} ${f.original?.slice(0, 12)} ${f.reproduced?.slice(0, 12)}`,
    )
  const same = r?.same === true
  console.log(
    same
      ? `reproduced ${scope}: every sampled frame matches`
      : `NOT reproduced ${scope}: ${error ?? 'frames differ'}`,
  )
  appendFileSync(
    join(dir, 'REPRODUCE.md'),
    [
      '',
      '## Verified at handoff',
      '',
      `Rendered ${scope}: ${same ? 'every sampled frame matches' : `NOT REPRODUCED (${error ?? 'frames differ'})`}.`,
      '',
      ...(r?.frames ?? []).map(
        (f) => `- t=${f.t}: ${f.reproduced} ${f.same ? 'same' : `differs from ${f.original}`}`,
      ),
      '',
    ].join('\n'),
  )
  return same ? 0 : 1
}
