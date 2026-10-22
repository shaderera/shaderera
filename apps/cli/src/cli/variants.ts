import type { Manifest } from '@shaderera/core'
import { findProject } from '../node/project.ts'
import { EXIT, errorFinding, type Finding, found } from './findings.ts'

/**
 * Where one variant's run of a command writes: its lines, its findings and its `--json` result.
 * With one variant they go straight out, as they always did; with several, each run's are kept
 * and printed together, grouped by variant.
 */
export type Output = {
  log(line: string): void
  found(f: Finding): void
  result(value: object): void
  /** The command runs for several variants: a given `--out` holds a folder for each. */
  several: boolean
}

/** One variant's run straight to stdout and the findings: what a command does with one variant. */
export const direct: Output = {
  log: (line) => console.log(line),
  found,
  result: (value) => console.log(JSON.stringify(value, null, 2)),
  several: false,
}

/**
 * The outputs a command runs for, from `--variant a,b` or `--variants a,b|all`: `undefined` is the
 * manifest's own output (`main`), as `deliver` names it. `all` is `main` and every variant the
 * manifest declares. A name the manifest declares is taken whole, even with a comma in it. An
 * unknown name is refused before anything opens.
 */
export const variantNames = (
  flags: { variant?: unknown; variants?: unknown },
  manifest: Manifest,
): (string | undefined)[] => {
  const declared = Object.keys(manifest.variants ?? {})
  if (typeof flags.variant === 'string' && typeof flags.variants === 'string')
    throw new Error('Give --variant or --variants, not both.')
  const given = typeof flags.variants === 'string' ? flags.variants : flags.variant
  if (typeof given !== 'string') return [undefined]
  const names =
    given === 'all' && typeof flags.variants === 'string'
      ? ['main', ...declared]
      : declared.includes(given)
        ? [given]
        : given
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
  if (names.length === 0) throw new Error(`No variant in "${given}".`)
  const unknown = names.filter((n) => n !== 'main' && !declared.includes(n))
  if (unknown.length > 0)
    throw new Error(
      `shaderera.json has no variant ${unknown.map((n) => `"${n}"`).join(', ')}${declared.length ? ` (it declares ${declared.join(', ')}, and main)` : ''}.`,
    )
  return [...new Set(names)].map((n) => (n === 'main' ? undefined : n))
}

/** A variant's name as the commands print it: `main` for the manifest's own output. */
export const nameOf = (variant: string | undefined) => variant ?? 'main'

/**
 * Runs a command once per variant it is given (`variantNames`). One variant runs as the command
 * always ran: `run` gets the flags as given, minus a `--variants` naming one. Several open one host
 * each and run at once; each one's lines are printed under its name, in the order given, its
 * findings carry it as `output`, and `--json` is one object, `{ variants: [{ variant, ...result }] }`.
 * One that throws is reported as its error (on stderr, or as `error` in its `--json` entry) and
 * the others still finish. The exit code is the worst
 * of them.
 */
export const eachVariant = async <
  F extends { root?: unknown; variant?: unknown; variants?: unknown },
>(
  flags: F,
  run: (flags: F, out: Output) => Promise<number>,
  o: {
    json?: boolean
    /** Why this run takes one variant only (a flag given that compares two): refused for several. */
    one?: string
  } = {},
): Promise<number> => {
  const { manifest } = await findProject(
    typeof flags.root === 'string' ? flags.root : process.cwd(),
  )
  const names = variantNames(flags, manifest)
  const flagsOf = (variant: string | undefined): F => {
    const { variant: _, variants: __, ...rest } = flags
    return (variant === undefined ? rest : { ...rest, variant }) as F
  }
  if (names.length === 1) return run(flagsOf(names[0]), direct)
  if (o.one) throw new Error(o.one)
  const runs = await Promise.all(
    names.map(async (variant) => {
      const lines: string[] = []
      const findings: Finding[] = []
      let result: object | undefined
      let error: string | undefined
      const out: Output = {
        log: (line) => lines.push(line),
        found: (f) => findings.push({ ...f, output: nameOf(variant) }),
        result: (value) => {
          result = value
        },
        several: true,
      }
      let exit: number
      try {
        exit = await run(flagsOf(variant), out)
      } catch (e) {
        const f = errorFinding(e)
        out.found(f)
        error = f.message
        exit = EXIT.error
      }
      return { variant, lines, findings, result, error, exit }
    }),
  )
  for (const r of runs) {
    for (const f of r.findings) found(f)
    if (r.error !== undefined && !o.json)
      console.error(`shaderera: ${nameOf(r.variant)}: ${r.error}`)
  }
  if (o.json)
    console.log(
      JSON.stringify(
        {
          variants: runs.map((r) => ({
            variant: nameOf(r.variant),
            ...(r.result === undefined ? { error: r.lines.join('\n') } : r.result),
          })),
        },
        null,
        2,
      ),
    )
  else
    for (const r of runs) {
      console.log(`${nameOf(r.variant)}:`)
      for (const line of r.lines) console.log(line.replace(/^/gm, '  '))
    }
  return Math.max(...runs.map((r) => r.exit))
}
