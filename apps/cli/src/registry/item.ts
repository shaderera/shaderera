import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize, sep } from 'node:path'
import { parseVersion, validRange } from './semver.ts'

/**
 * A plugin's label (decision 0008): what it is, which part of the work it covers, what it
 * needs and its licence. It is for finding things and resolving dependencies only. The host never
 * reads it to render, so nothing in it may change a frame: what a film looks like is its code.
 *
 * Components, presets and media carry `shaderera.item.json`. An extension is an npm
 * package and carries the same fields under `shaderera` in its package.json, which already gives
 * its name, version, description and licence.
 */
export const ITEM_FILE = 'shaderera.item.json'

/** Templates were retired by decision 0011: a project starts empty. */
export const TYPES = ['extension', 'component', 'preset', 'media'] as const
export type ItemType = (typeof TYPES)[number]

const WORK = [
  'Audio & Music',
  'Analysis & Tracking',
  'Typography',
  'Looks',
  'Color',
  'Procedural & Particles',
  'Transitions',
  'Animation & Camera',
  'Rendering',
  'Layout & Formats',
  'Assets & Rights',
] as const

/**
 * The starting categories of each type: media by kind, the rest by which part of the work they
 * cover. Loose on purpose: another category is a warning, a proposal, not an error.
 */
export const CATEGORIES: { readonly [T in ItemType]: readonly string[] } = {
  extension: WORK,
  component: WORK,
  preset: WORK,
  media: ['Music', 'Sound Effects', 'Fonts', '3D Models', 'Images'],
}

export type Requires = {
  /** A range of the `shaderera` package (core and the CLI share one version). */
  readonly shaderera?: string
  /** Extensions by package name, each with a range. */
  readonly extensions: { readonly [name: string]: string }
  /**
   * Components, presets or media by name, each with a range: copied in with this item, and from
   * then on the project's own code, so the project's label never records them.
   */
  readonly items: { readonly [name: string]: string }
  /** npm packages the copied code imports (three, fast-png…), by name with a range: installed with it. */
  readonly packages: { readonly [name: string]: string }
}

export type Item = {
  readonly name: string
  readonly type: ItemType
  readonly title: string
  readonly description: string
  readonly category: string
  readonly tags: readonly string[]
  readonly version: string
  readonly licence: string
  readonly requires: Requires
  /** What `shaderera add` copies into a project: paths relative to the item (components, presets, media). */
  readonly files: readonly string[]
  /** Where media came from: its origin, and for generated media the generator and its terms. */
  readonly source?: {
    readonly origin: string
    readonly generator?: string
    readonly terms?: string
  }
}

const KNOWN = new Set([
  '$schema',
  'name',
  'type',
  'title',
  'description',
  'category',
  'tags',
  'version',
  'licence',
  'requires',
  'files',
  'source',
])

/**
 * A package-style name, npm's: an optional scope, then no leading dot, so a name never climbs
 * out of the registry's folders or reads as a flag on an npm command line.
 */
export const NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i

const isObject = (v: unknown): v is { [key: string]: unknown } =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Checks an item's label. Throws on what would make it unusable (no name, an unknown type, a
 * version or range that cannot be read, a file path outside the item). Anything merely unusual (a
 * new category, an unknown key, no description) comes back as a warning.
 */
export const checkItem = (raw: unknown, where: string): { item: Item; warnings: string[] } => {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isObject(raw)) throw new Error(`${where}: a plugin's label is a JSON object`)
  const str = (key: string, required: boolean): string => {
    const v = raw[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (v !== undefined && typeof v !== 'string') errors.push(`${key} must be a string`)
    else if (required) errors.push(`${key} is required`)
    return ''
  }
  const name = str('name', true)
  if (name && !NAME.test(name)) errors.push(`name "${name}" is not a package-style name`)
  // Or `scope__name` would share the folder `@scope/name` is kept in (folderName).
  else if (name.includes('__'))
    errors.push(`name "${name}" has "__": the registry keeps @scope/name in a folder scope__name`)
  const type = str('type', true) as ItemType
  if (type && !TYPES.includes(type)) errors.push(`type must be one of ${TYPES.join(', ')}`)
  const title = str('title', false) || name
  const description = str('description', false)
  if (!description) warnings.push('no description: search shows one line about the plugin')
  const category = str('category', true)
  if (category && TYPES.includes(type) && !CATEGORIES[type].includes(category))
    warnings.push(
      `category "${category}" is new for ${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type} (known: ${CATEGORIES[type].join(', ')})`,
    )
  const version = str('version', true)
  if (version && !parseVersion(version)) errors.push(`version "${version}" is not x.y.z`)
  const licence = str('licence', true)

  const tags: string[] = []
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== 'string'))
      errors.push('tags must be a list of strings')
    else tags.push(...raw.tags.map((t: string) => t.trim()).filter(Boolean))
  }

  const extensions: { [name: string]: string } = {}
  const items: { [name: string]: string } = {}
  const packages: { [name: string]: string } = {}
  let shaderera: string | undefined
  if (raw.requires !== undefined) {
    if (!isObject(raw.requires)) errors.push('requires must be an object')
    else {
      const r = raw.requires
      if (r.shaderera !== undefined) {
        if (typeof r.shaderera !== 'string' || !validRange(r.shaderera))
          errors.push(`requires.shaderera "${String(r.shaderera)}" is not a version range`)
        else shaderera = r.shaderera
      }
      for (const [key, into] of [
        ['extensions', extensions],
        ['items', items],
        ['packages', packages],
      ] as const) {
        if (r[key] === undefined) continue
        if (!isObject(r[key])) errors.push(`requires.${key} must be an object of name: range`)
        else
          for (const [name, range] of Object.entries(r[key])) {
            if (!NAME.test(name)) errors.push(`requires.${key}: "${name}" is not a package name`)
            else if (typeof range !== 'string' || !validRange(range))
              errors.push(`requires.${key}.${name} "${String(range)}" is not a version range`)
            else into[name] = range
          }
      }
      for (const key of Object.keys(r))
        if (!['shaderera', 'extensions', 'items', 'packages'].includes(key))
          warnings.push(`requires.${key} is not read`)
    }
  }

  const files: string[] = []
  if (raw.files !== undefined) {
    if (!Array.isArray(raw.files) || raw.files.some((f) => typeof f !== 'string'))
      errors.push('files must be a list of paths')
    else
      for (const f of raw.files as string[]) {
        const n = normalize(f)
        if (isAbsolute(f) || n.split(sep).includes('..'))
          errors.push(`file "${f}" is outside the plugin`)
        else files.push(f)
      }
  }
  if (['component', 'preset', 'media'].includes(type) && files.length === 0)
    warnings.push(`a ${type} with no files: shaderera add has nothing to copy`)

  let source: Item['source']
  if (raw.source !== undefined) {
    const s = raw.source
    if (!isObject(s) || typeof s.origin !== 'string') errors.push('source needs an origin')
    else
      source = {
        origin: s.origin,
        ...(typeof s.generator === 'string' ? { generator: s.generator } : {}),
        ...(typeof s.terms === 'string' ? { terms: s.terms } : {}),
      }
  }
  if (type === 'media' && !source) warnings.push('media without a source: say where it came from')

  for (const key of Object.keys(raw)) if (!KNOWN.has(key)) warnings.push(`${key} is not read`)
  if (errors.length > 0) throw new Error(`${where}: ${errors.join('; ')}`)
  return {
    item: {
      name,
      type,
      title,
      description,
      category,
      tags,
      version,
      licence,
      requires: { ...(shaderera ? { shaderera } : {}), extensions, items, packages },
      files,
      ...(source ? { source } : {}),
    },
    warnings,
  }
}

/**
 * The raw label of the item in `dir`: its `shaderera.item.json`, or the `shaderera` field of its
 * package.json filled in from the package itself. Null when the folder is not an item.
 */
export const rawItem = (dir: string): { raw: { [key: string]: unknown }; file: string } | null => {
  const file = join(dir, ITEM_FILE)
  if (existsSync(file)) return { raw: JSON.parse(readFileSync(file, 'utf8')), file }
  const pkgFile = join(dir, 'package.json')
  if (!existsSync(pkgFile)) return null
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  if (!isObject(pkg.shaderera)) return null
  const own = pkg.shaderera as { [key: string]: unknown }
  const core = pkg.peerDependencies?.['@shaderera/core'] ?? pkg.peerDependencies?.shaderera
  const requires = isObject(own.requires) ? own.requires : {}
  return {
    file: pkgFile,
    raw: {
      type: 'extension',
      ...own,
      name: pkg.name,
      version: pkg.version,
      description: own.description ?? pkg.description,
      licence: own.licence ?? pkg.license,
      requires: { ...(typeof core === 'string' ? { shaderera: core } : {}), ...requires },
    },
  }
}
