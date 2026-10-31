import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'
import type { Json, Manifest } from '@shaderera/core'
import { withVariant } from '@shaderera/core/host'
import { buildForNode } from '../node/build.ts'
import type { Child } from '../node/child.ts'
import { hostOf } from '../node/host-of.ts'
import { hostOpener, openHosts } from '../node/open-host.ts'
import { findProject, type Project } from '../node/project.ts'
import { checkBakes } from '../project/bakes.ts'
import { effectiveParams } from '../project/jobs.ts'
import { variantList } from './variants.ts'

/**
 * The common flags: `--root`, `--variant`, `--trusted`, `--timeout <s>` and `--host node|browser`
 * (overrides the manifest's host for this run).
 */
export const common = {
  root: { type: 'string' as const },
  variant: { type: 'string' as const },
  trusted: { type: 'boolean' as const },
  timeout: { type: 'string' as const },
  host: { type: 'string' as const },
}

/** Parses a command's flags plus the common ones. */
export const parse = <O extends ParseArgsOptionsConfig>(argv: readonly string[], options: O) =>
  parseArgs({ args: [...argv], options: { ...options, ...common } }).values

/** Like `parse`, for a command that also takes positional arguments (revision ids). */
export const parseWithPositionals = <O extends ParseArgsOptionsConfig>(
  argv: readonly string[],
  options: O,
) =>
  parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { ...options, root: { type: 'string' as const } },
  })

/**
 * The flags of every command that renders the source (`check`, `inspect`, `still`, `render`,
 * `review`): `--param k=v` (repeatable) and `--time <s>` (repeatable), the times also given as
 * positionals.
 */
export const rendering = {
  param: { type: 'string' as const, multiple: true as const },
  time: { type: 'string' as const, multiple: true as const },
}

/**
 * Parses a command that renders: its flags, the common ones and `rendering`. `times` are the
 * positionals and `--time`s, in seconds; a command that takes none (`times: false`) refuses them.
 */
export const parseRendering = <O extends ParseArgsOptionsConfig>(
  argv: readonly string[],
  options: O,
  o: { command: string; times: boolean },
) => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { ...options, ...common, ...rendering },
  })
  const given = [...positionals, ...((values as { time?: string[] }).time ?? [])]
  if (!o.times && given.length > 0)
    throw new Error(`shaderera ${o.command} takes no times (${given.join(', ')}).`)
  return { values, times: timesOf(given) }
}

/** Times given in seconds as numbers; throws naming any that is not one. */
export const timesOf = (given: readonly string[]): number[] => {
  const times = given.map(Number)
  const bad = given.filter((_, i) => !Number.isFinite(times[i]))
  if (bad.length > 0) throw new Error(`Not a time in seconds: ${bad.join(', ')}.`)
  return times
}

/** Throws naming the times outside the film: from 0 up to but not including its duration. */
export const insideFilm = (times: readonly number[], duration: number) => {
  const outside = times.filter((t) => t < 0 || t >= duration)
  if (outside.length > 0)
    throw new Error(`Outside the film (0 to ${duration} s): ${outside.join(', ')}.`)
}

/** `key=value`, the value as JSON when it parses and as a string when not. */
export const parseParam = (kv: string): [string, Json] => {
  const at = kv.indexOf('=')
  if (at < 1) throw new Error(`--param needs key=value, not "${kv}".`)
  const raw = kv.slice(at + 1)
  try {
    return [kv.slice(0, at), JSON.parse(raw) as Json]
  } catch {
    return [kv.slice(0, at), raw]
  }
}

/**
 * Finds the project and opens it in its host (hostOf): the Node host builds it and opens it in a
 * child process; the browser host opens it on a headless Chrome (node/browser.ts: WebGPU, the
 * project's DOM). With `--variant`, the manifest is that variant's and its params go over the
 * defaults; `resized` overrides the frame size (review's resized reopen); `--param`s go over both,
 * and a name the manifest's params schema does not declare is refused (effectiveParams). Every
 * bake the manifest declares is checked against its stamp first, and refused when stale
 * (project/bakes.ts); its frames are what the source's io.bake reads. `extra` says how many more
 * hosts the run needs (from the manifest it renders): they open at once with the first, in `extra`.
 * `--hdr10` opens the source in an hdr10 range (`host.range`, decision 0023): refused without the
 * manifest's `hdr10` or a GPUDevice. `draft`, a height in pixels (render --draft), opens it at
 * draftSize, as a variant of that size would open it, and its clips come from the decoder scaled
 * by as much.
 */
export const open = async (
  flags: {
    root?: unknown
    variant?: unknown
    trusted?: unknown
    timeout?: unknown
    host?: unknown
    param?: unknown
    hdr10?: unknown
    draft?: unknown
  },
  resized?: { width: number; height: number },
  extra: (manifest: Manifest) => number = () => 0,
): Promise<{ project: Project; child: Child; more: () => Promise<Child>; extra: Child[] }> => {
  const found = await findProject(typeof flags.root === 'string' ? flags.root : process.cwd())
  const name = typeof flags.variant === 'string' ? flags.variant : undefined
  // An unknown name is refused naming the nearest declared one.
  if (name !== undefined) variantList([name], found.manifest)
  const { manifest, params: variantParams } = withVariant(found.manifest, name)
  const draft = typeof flags.draft === 'number' ? draftSize(manifest, flags.draft) : undefined
  const size = draft ?? resized
  const given = Object.fromEntries(
    (Array.isArray(flags.param) ? (flags.param as string[]) : []).map(parseParam),
  )
  const params = effectiveParams(manifest, variantParams, given)
  const bakes = checkBakes(found.root, found.manifest)
  const variant = { ...found, manifest }
  const more = await hostOpener(hostOf(manifest, flags.host), variant, {
    params,
    ...(name ? { variant: name } : {}),
    ...(size ? { size } : {}),
    ...(draft && draft.height !== manifest.height
      ? { videoScale: draft.height / manifest.height }
      : {}),
    ...(flags.hdr10 === true ? { range: 'hdr10' as const } : {}),
    bakes,
    ...childOptions(flags),
    build: async () => ({ project: variant, entryFile: await buildForNode(variant) }),
  })
  const project = { ...found, manifest: size ? { ...manifest, ...size } : manifest }
  const [child, ...others] = await openHosts(more, 1 + extra(project.manifest))
  return { project, child: child as Child, more, extra: others }
}

/** A draft's height when `--draft` gives none: enough to judge flow, timing and transitions. */
export const DRAFT_HEIGHT = 360

/**
 * A draft's frame (render --draft): `height` pixels high and as wide as the film's aspect makes
 * it, each side rounded to an even number so that H.264's 4:2:0 takes it. Never larger than the
 * film: a height at or above its own gives its own size.
 */
export const draftSize = (
  { width, height }: { width: number; height: number },
  draft: number = DRAFT_HEIGHT,
) => {
  if (draft >= height) return { width, height }
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  return { width: even((width * draft) / height), height: even(draft) }
}

/**
 * `--draft [height]`: the height in pixels, DRAFT_HEIGHT when none follows; undefined without
 * the flag. A command that takes no positionals reads the token after `--draft` as its height.
 */
export const draftArgs = (argv: readonly string[]): { argv: string[]; draft?: number } => {
  const at = argv.findIndex((a) => a === '--draft' || a.startsWith('--draft='))
  if (at < 0) return { argv: [...argv] }
  const flag = argv[at] as string
  const next = argv[at + 1]
  const given = flag.includes('=')
    ? flag.slice(flag.indexOf('=') + 1)
    : next !== undefined && !next.startsWith('-')
      ? next
      : undefined
  const rest = [
    ...argv.slice(0, at),
    ...argv.slice(at + (flag.includes('=') || given === undefined ? 1 : 2)),
  ]
  if (rest.some((a) => a === '--draft' || a.startsWith('--draft=')))
    throw new Error('--draft is given once.')
  if (given === undefined) return { argv: rest, draft: DRAFT_HEIGHT }
  const n = Number(given)
  if (!Number.isInteger(n) || n < 2)
    throw new Error(`--draft takes a height in pixels, such as 360 or 540, not "${given}".`)
  return { argv: rest, draft: n }
}

/** `--trusted` and `--timeout <s>` as the host's options. */
export const childOptions = (flags: { trusted?: unknown; timeout?: unknown }) => ({
  trusted: flags.trusted === true,
  timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) * 1000 : undefined,
})
