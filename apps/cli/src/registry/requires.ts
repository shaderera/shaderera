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

type Requires = { shaderera?: string; extensions?: { [name: string]: string } }

const MANIFEST = 'shaderera.json'

/**
 * A project's `requires`, from its shaderera.json. A project's requires lived in
 * shaderera.item.json before 0.1.5 (plugins keep theirs there): one still there is refused.
 */
export const readRequires = (root: string): Requires | undefined => {
  const old = join(root, ITEM_FILE)
  if (existsSync(old) && JSON.parse(readFileSync(old, 'utf8')).requires !== undefined)
    throw new Error(
      `${ITEM_FILE}: a project's requires moved into ${MANIFEST} in 0.1.5. Move "requires" there and delete ${ITEM_FILE}.`,
    )
  return JSON.parse(readFileSync(join(root, MANIFEST), 'utf8')).requires
}

/** Sets (a range) or removes (null) one extension the project requires, in its shaderera.json. */
export const setRequirement = (root: string, name: string, range: string | null): void => {
  const { extensions = {}, ...rest } = readRequires(root) ?? {}
  const file = join(root, MANIFEST)
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const next = { ...extensions }
  if (range === null) delete next[name]
  else next[name] = range
  const requires = Object.keys(next).length > 0 ? { ...rest, extensions: next } : rest
  if (Object.keys(requires).length > 0) manifest.requires = requires
  else delete manifest.requires
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * What the project at `root` needs and does not have, by its shaderera.json `requires`: the
 * shaderera range, and every extension installed in a version its range allows. Empty when
 * nothing is missing or the project declares nothing.
 */
export const requirementProblems = (
  root: string,
  shadereraVersion: string,
): { name: string; range: string; problem: string }[] => {
  const requires = readRequires(root)
  if (!requires) return []
  const problems: { name: string; range: string; problem: string }[] = []
  const core = requires.shaderera
  if (core !== undefined && (typeof core !== 'string' || !validRange(core)))
    problems.push({ name: 'shaderera', range: String(core), problem: 'not a version range' })
  else if (core !== undefined && !satisfies(shadereraVersion, core))
    problems.push({ name: 'shaderera', range: core, problem: `this is ${shadereraVersion}` })
  for (const [name, range] of Object.entries(requires.extensions ?? {})) {
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
    [`This project needs what is not installed (${MANIFEST} requires):`, ...lines, ...fix].join(
      '\n',
    ),
  )
}
