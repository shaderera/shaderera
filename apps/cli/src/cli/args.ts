import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'
import type { Json } from '@shaderera/core'
import { withVariant } from '@shaderera/core/host'
import { openBrowserChild } from '../node/browser.ts'
import { buildForNode } from '../node/build.ts'
import { type Child, openChild } from '../node/child.ts'
import { hostOf } from '../node/host-of.ts'
import { findProject, type Project } from '../node/project.ts'
import { checkBakes } from '../project/bakes.ts'
import { effectiveParams } from '../project/jobs.ts'

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
 * defaults; `size` overrides the frame size (review's resized reopen); `--param`s go over both,
 * and a name the manifest's params schema does not declare is refused (effectiveParams). Every
 * bake the manifest declares is checked against its stamp first, and refused when stale
 * (project/bakes.ts); its frames are what the source's io.bake reads.
 */
export const open = async (
  flags: {
    root?: unknown
    variant?: unknown
    trusted?: unknown
    timeout?: unknown
    host?: unknown
    param?: unknown
  },
  size?: { width: number; height: number },
): Promise<{ project: Project; child: Child; more: () => Promise<Child> }> => {
  const found = await findProject(typeof flags.root === 'string' ? flags.root : process.cwd())
  const name = typeof flags.variant === 'string' ? flags.variant : undefined
  const { manifest, params: variantParams } = withVariant(found.manifest, name)
  const given = Object.fromEntries(
    (Array.isArray(flags.param) ? (flags.param as string[]) : []).map(parseParam),
  )
  const params = effectiveParams(manifest, variantParams, given)
  const project = { ...found, manifest: size ? { ...manifest, ...size } : manifest }
  const bakes = checkBakes(found.root, found.manifest)
  if (hostOf(manifest, flags.host) === 'browser') {
    const more = () =>
      openBrowserChild(found, {
        params,
        ...(name ? { variant: name } : {}),
        ...(size ? { size } : {}),
        timeoutMs: childOptions(flags).timeoutMs,
        bakes,
      })
    return { project, child: await more(), more }
  }
  const entryFile = await buildForNode(project)
  // Another host on the same build: a parallel export opens several.
  const more = () =>
    openChild(project, {
      entryFile,
      params,
      bakes,
      ...childOptions(flags),
    })
  return { project, child: await more(), more }
}

/** `--trusted` and `--timeout <s>` as openChild's options. */
export const childOptions = (flags: { trusted?: unknown; timeout?: unknown }) => ({
  trusted: flags.trusted === true,
  timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) * 1000 : undefined,
})
