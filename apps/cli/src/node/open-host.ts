import type { Json } from '@shaderera/core'
import { openBrowserChild } from './browser.ts'
import { type Child, openChild } from './child.ts'
import type { HostName } from './host-of.ts'
import type { Project } from './project.ts'
import type { BakeFrames } from './services.ts'

/** What a run opens a source with, whichever host runs it. */
export type HostOptions = {
  params: { [key: string]: Json }
  /** The source's `host.seed`: a job's own; by default the manifest's, or 0. */
  seed?: number
  variant?: string
  /** A saved revision, which the browser host opens from its frozen entry and DOM. */
  revision?: string
  /** Overrides the manifest's frame size (review's resized reopen). */
  size?: { width: number; height: number }
  /** The bakes' frames, checked against their stamps: what io.bake reads. */
  bakes?: BakeFrames
  /** No permission flags on the Node host's process (`--trusted`). */
  trusted?: boolean
  timeoutMs?: number
}

/**
 * The one place a run picks its host and opens it (`hostOf` names which): returns an opener, and
 * each call opens another host on the same source, as a parallel export does. `project` is the
 * project and the manifest the run renders, its variant applied. The Node host runs `build()`'s
 * entry, built once here: the project's own build, or a revision's frozen copy. The browser host
 * serves `project`'s runner and opens the variant, revision and size in its page.
 */
export const hostOpener = async (
  host: HostName,
  project: Project,
  o: HostOptions & { build: () => Promise<{ project: Project; entryFile: string }> },
): Promise<() => Promise<Child>> => {
  const common = {
    params: o.params,
    ...(o.seed !== undefined ? { seed: o.seed } : {}),
    ...(o.variant ? { variant: o.variant } : {}),
    ...(o.bakes ? { bakes: o.bakes } : {}),
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
  }
  if (host === 'browser')
    return () =>
      openBrowserChild(project, {
        ...common,
        ...(o.revision ? { revision: o.revision } : {}),
        ...(o.size ? { size: o.size } : {}),
      })
  const built = await o.build()
  const sized = o.size
    ? { ...built.project, manifest: { ...built.project.manifest, ...o.size } }
    : built.project
  return () =>
    openChild(sized, { ...common, entryFile: built.entryFile, trusted: o.trusted === true })
}

/**
 * `n` more hosts from an opener, all opening at once (each runs the source's open). If one
 * fails, the ones that opened are closed and its error is thrown.
 */
export const openHosts = async (more: () => Promise<Child>, n: number): Promise<Child[]> => {
  const opened = await Promise.allSettled(Array.from({ length: n }, () => more()))
  const hosts = opened.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  const failed = opened.find((r) => r.status === 'rejected')
  if (failed) {
    await Promise.all(hosts.map((h) => h.close()))
    throw (failed as PromiseRejectedResult).reason
  }
  return hosts
}
