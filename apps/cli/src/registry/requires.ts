import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ITEM_FILE } from './item.ts'
import { satisfies, validRange } from './semver.ts'

/** The package.json of an installed package, looked up from `root` through parent node_modules. */
export const installedPackage = (
  root: string,
  name: string,
): { version?: string; shaderera?: unknown } | null => {
  let dir = root
  for (;;) {
    const file = join(dir, 'node_modules', ...name.split('/'), 'package.json')
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** The version of an installed package, looked up from `root` through parent node_modules. */
export const installedVersion = (root: string, name: string): string | null =>
  installedPackage(root, name)?.version ?? null

type Label = {
  [key: string]: unknown
  requires?: { shaderera?: string; extensions?: { [name: string]: string } }
}

/** A project's label: its `shaderera.item.json`, which may hold nothing but `requires`. */
export const readLabel = (root: string): Label | null => {
  const file = join(root, ITEM_FILE)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
}

export const writeLabel = (root: string, label: Label): void =>
  writeFileSync(join(root, ITEM_FILE), `${JSON.stringify(label, null, 2)}\n`)

/** Sets (a range) or removes (null) one extension the project requires. */
export const setRequirement = (root: string, name: string, range: string | null): void => {
  const label = readLabel(root) ?? {}
  const extensions = { ...(label.requires?.extensions ?? {}) }
  if (range === null) delete extensions[name]
  else extensions[name] = range
  writeLabel(root, { ...label, requires: { ...label.requires, extensions } })
}

/**
 * What the project at `root` needs and does not have, by its `shaderera.item.json`: the
 * shaderera range, and every extension installed in a version its range allows. Empty when
 * nothing is missing or the project declares nothing.
 */
export const requirementProblems = (
  root: string,
  shadereraVersion: string,
): { name: string; range: string; problem: string }[] => {
  const label = readLabel(root)
  if (!label?.requires) return []
  const problems: { name: string; range: string; problem: string }[] = []
  const core = label.requires.shaderera
  if (core !== undefined && (typeof core !== 'string' || !validRange(core)))
    problems.push({ name: 'shaderera', range: String(core), problem: 'not a version range' })
  else if (core !== undefined && !satisfies(shadereraVersion, core))
    problems.push({ name: 'shaderera', range: core, problem: `this is ${shadereraVersion}` })
  for (const [name, range] of Object.entries(label.requires.extensions ?? {})) {
    if (typeof range !== 'string' || !validRange(range)) {
      problems.push({ name, range: String(range), problem: 'not a version range' })
      continue
    }
    const v = installedVersion(root, name)
    if (v === null) problems.push({ name, range, problem: 'not installed' })
    else if (!satisfies(v, range)) problems.push({ name, range, problem: `installed: ${v}` })
  }
  return problems
}

/**
 * Refuses a project whose requirements are not met (decision 0008's one hard rule: never a
 * silent fallback), and names the two ways out, so a package plugin never stands in the way of
 * what the person wants: install it, or remove it and write their own.
 */
export const assertRequirements = (root: string, shadereraVersion: string): void => {
  const problems = requirementProblems(root, shadereraVersion)
  if (problems.length === 0) return
  const lines = problems.map((p) => `  - ${p.name} ${p.range} (${p.problem})`)
  const ext = problems.find((p) => p.name !== 'shaderera')
  const fix = ext
    ? [
        'Fix it one of two ways:',
        `  npx shaderera add ${ext.name}@${ext.range}   install it`,
        `  npx shaderera remove ${ext.name}   stop requiring it, and write your own`,
      ]
    : ['Install a shaderera in that range, or change requires.shaderera.']
  throw new Error(
    [`This project needs what is not installed (${ITEM_FILE}):`, ...lines, ...fix].join('\n'),
  )
}
