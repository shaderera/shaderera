import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { safeName } from '../project/jobs.ts'
import { outputRequirements, type Requirements, readRequirements } from '../project/requirements.ts'
import { type Check, review } from '../review/review.ts'
import { open, parseRendering } from './args.ts'
import { EXIT, type Finding } from './findings.ts'
import { eachVariant, type Output } from './variants.ts'

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

/**
 * `shaderera review [--variant a,b | --variants all] [--out dir] [--requirements file] [--quick]
 * [--param k=v]...`: each variant in its own host, at once (eachVariant), into its own folder.
 */
export const run = async (argv: readonly string[]): Promise<number> => {
  const { values } = parseRendering(
    argv,
    {
      out: { type: 'string' },
      requirements: { type: 'string' },
      quick: { type: 'boolean' },
      json: { type: 'boolean' },
      variants: { type: 'string' },
    },
    { command: 'review', times: false },
  )
  return eachVariant(values, reviewOne, { json: values.json === true })
}

const reviewOne = async (
  v: Parameters<typeof open>[0] & {
    out?: string
    requirements?: string
    quick?: boolean
    json?: boolean
  },
  out: Output,
): Promise<number> => {
  const { project, child } = await open(v)
  try {
    const variant = typeof v.variant === 'string' ? v.variant : undefined
    // A given file is used as it is; the project's is applied to this output (outputRequirements).
    const requirements: Requirements =
      typeof v.requirements === 'string'
        ? JSON.parse(readFileSync(resolve(v.requirements), 'utf8'))
        : outputRequirements(readRequirements(project.root), { variant, ...project.manifest })
    // Several variants given --out: each in its own folder under it, as out/review/ holds them.
    const folder = safeName(variant ?? 'main')
    const outDir =
      typeof v.out === 'string'
        ? join(resolve(v.out), ...(out.several ? [folder] : []))
        : join(project.root, 'out', 'review', ...(variant ? [folder] : []))
    const r = await review({
      project,
      child,
      outDir,
      requirements,
      quick: v.quick === true,
      reopen: async (size) => (await open(v, size)).child,
      // A film with hdr10: its HDR10 render's light, as numbers.
      ...(project.manifest.hdr10
        ? { hdr: async () => (await open({ ...v, hdr10: true })).child }
        : {}),
    })
    if (v.json) out.result(r)
    else {
      for (const c of r.checks) out.log(formatCheck(c))
      out.log(`${r.contactSheet}
${r.frames.length} frames in ${(r.elapsedMs / 1000).toFixed(1)} s`)
    }
    for (const f of checkFindings(r.checks, variant)) out.found(f)
    return r.checks.some((c) => c.status === 'fail') ? EXIT.failed : EXIT.ok
  } finally {
    await child.close()
  }
}
