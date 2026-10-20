import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { safeName } from '../project/jobs.ts'
import { outputRequirements, type Requirements, readRequirements } from '../project/requirements.ts'
import { type Check, review } from '../review/review.ts'
import { open, parseRendering } from './args.ts'
import { EXIT, type Finding, found } from './findings.ts'

const SEVERITY = { fail: 'error', unknown: 'warning', info: 'info' } as const

/** A review's checks as findings: a failing check is an error, one per place it is about. */
export const checkFindings = (checks: readonly Check[], output?: string): Finding[] =>
  checks.flatMap((c): Finding[] => {
    if (c.status === 'pass') return []
    const base: Finding = {
      code: c.id,
      severity: SEVERITY[c.status],
      message: [c.title, c.detail].filter(Boolean).join(': '),
      ...(c.measured ? { measured: c.measured } : {}),
      ...(output ? { output } : {}),
    }
    if (c.where?.length)
      return c.where.slice(0, 50).map((w) => ({
        ...base,
        message: `${c.title}: ${w.id}`,
        t: [w.t],
        bbox: w.box,
      }))
    return [{ ...base, ...(c.at?.length ? { t: c.at } : {}) }]
  })

/** `·`: measured only; nothing in requirements.json asks this of the film (decision 0011). */
const mark = { pass: '✓', fail: '✗', unknown: '?', info: '·' } as const

/** One line per check: mark, title, what it measured, and its detail. */
export const formatCheck = (c: Check): string =>
  [`${mark[c.status]} ${c.title}`, c.measured, c.detail].filter(Boolean).join(' · ') +
  (c.at?.length ? ` @ ${c.at.slice(0, 8).join(', ')}` : '')

/** `shaderera review [--variant name] [--out dir] [--requirements file] [--quick] [--param k=v]...` */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values: v } = parseRendering(
    argv,
    {
      out: { type: 'string' },
      requirements: { type: 'string' },
      quick: { type: 'boolean' },
      json: { type: 'boolean' },
    },
    { command: 'review', times: false },
  )
  const { project, child } = await open(v)
  try {
    const variant = typeof v.variant === 'string' ? v.variant : undefined
    // A given file is used as it is; the project's is applied to this output (outputRequirements).
    const requirements: Requirements =
      typeof v.requirements === 'string'
        ? JSON.parse(readFileSync(resolve(v.requirements), 'utf8'))
        : outputRequirements(readRequirements(project.root), { variant, ...project.manifest })
    const outDir =
      typeof v.out === 'string'
        ? resolve(v.out)
        : join(project.root, 'out', 'review', ...(variant ? [safeName(variant)] : []))
    const r = await review({
      project,
      child,
      outDir,
      requirements,
      quick: v.quick === true,
      reopen: async (size) => (await open(v, size)).child,
    })
    if (v.json) console.log(JSON.stringify(r, null, 2))
    else {
      for (const c of r.checks) console.log(formatCheck(c))
      console.log(
        `${r.contactSheet}\n${r.frames.length} frames in ${(r.elapsedMs / 1000).toFixed(1)} s`,
      )
    }
    for (const f of checkFindings(r.checks, variant)) found(f)
    return r.checks.some((c) => c.status === 'fail') ? EXIT.failed : EXIT.ok
  } finally {
    await child.close()
  }
}
