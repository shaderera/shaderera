import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'
import type { Json } from '@shaderera/core'
import { paramDefaults, withVariant } from '@shaderera/core/host'
import { openBrowserChild } from '../node/browser.ts'
import { buildForNode } from '../node/build.ts'
import { type Child, openChild } from '../node/child.ts'
import { hostOf } from '../node/host-of.ts'
import { findProject, type Project } from '../node/project.ts'

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
 * Finds the project and opens it in its host (hostOf): the Node host builds it and opens it in a
 * child process; the browser host opens it on a headless Chrome (node/browser.ts: WebGPU, the
 * project's DOM). With `--variant`, the manifest is that variant's and its params go over the
 * defaults; `size` overrides the frame size (review's resized reopen); `given` params go over both.
 */
export const open = async (
  flags: {
    root?: unknown
    variant?: unknown
    trusted?: unknown
    timeout?: unknown
    host?: unknown
  },
  size?: { width: number; height: number },
  given: { readonly [key: string]: Json } = {},
): Promise<{ project: Project; child: Child; more: () => Promise<Child> }> => {
  const found = await findProject(typeof flags.root === 'string' ? flags.root : process.cwd())
  const name = typeof flags.variant === 'string' ? flags.variant : undefined
  const { manifest, params } = withVariant(found.manifest, name)
  const project = { ...found, manifest: size ? { ...manifest, ...size } : manifest }
  if (hostOf(manifest, flags.host) === 'browser') {
    const more = () =>
      openBrowserChild(found, {
        params: { ...paramDefaults(manifest), ...params, ...given },
        ...(name ? { variant: name } : {}),
        ...(size ? { size } : {}),
        timeoutMs: childOptions(flags).timeoutMs,
      })
    return { project, child: await more(), more }
  }
  const entryFile = await buildForNode(project)
  // Another host on the same build: a parallel export opens several.
  const more = () =>
    openChild(project, {
      entryFile,
      params: { ...paramDefaults(manifest), ...params, ...given },
      ...childOptions(flags),
    })
  return { project, child: await more(), more }
}

/** `--trusted` and `--timeout <s>` as openChild's options. */
export const childOptions = (flags: { trusted?: unknown; timeout?: unknown }) => ({
  trusted: flags.trusted === true,
  timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) * 1000 : undefined,
})
