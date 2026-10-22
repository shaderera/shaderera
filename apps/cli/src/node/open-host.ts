import type { Json, Range } from '@shaderera/core'
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
  /** The source's `host.range`: a job's own; `sdr` when absent. */
  range?: Range
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
    ...(o.range ? { range: o.range } : {}),
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

/** What a GPU says when it cannot go on: a lost or removed device, or memory it could not get. */
const DEVICE =
  /device was lost|device removed|DXGI_ERROR|out of memory|E_OUTOFMEMORY|CreateCommittedResource|WebGPU reported/i

/** A host process that crashed in native code: a Windows NTSTATUS code (0xC0000000 up) or a signal. */
const crashed = (message: string): boolean => {
  const code = /The source process exited \((\w+)\)/.exec(message)?.[1]
  return code !== undefined && (/^SIG/.test(code) || Number(code) >= 0xc0000000)
}

/**
 * The usual way out of a GPU device error or a host crash when `hosts` shared the GPU: every host
 * holds its own copy of the film's GPU memory, so fewer hosts need less. '' otherwise.
 */
const workersHint = (message: string, hosts: number): string =>
  hosts > 1 && (DEVICE.test(message) || crashed(message))
    ? ` ${hosts} hosts (--workers ${hosts}) shared the GPU, each with its own memory: render with fewer --workers (--workers 1 for one).`
    : ''

/**
 * A host's error with the frame it happened at. A device error or a crash also names the way out:
 * fewer hosts (workersHint), or with one, less other work on the GPU.
 */
export const frameError = (error: unknown, t: number, fps: number, hosts: number): Error => {
  const message = error instanceof Error ? error.message : String(error)
  const way =
    hosts > 1
      ? workersHint(message, hosts)
      : DEVICE.test(message)
        ? ' The GPU ran out or reset: close other work on it, or make the film need less memory.'
        : ''
  return new Error(`Frame ${Math.round(t * fps)} (t ${t} s) failed: ${message}${way}`, {
    cause: error,
  })
}

/**
 * `n` more hosts from an opener, all opening at once (each runs the source's open). If one
 * fails, the ones that opened are closed and its error is thrown, with workersHint for the
 * `hosts` the run asked for (`n` by default; one more when its first is already open).
 */
export const openHosts = async (
  more: () => Promise<Child>,
  n: number,
  hosts = n,
): Promise<Child[]> => {
  const opened = await Promise.allSettled(Array.from({ length: n }, () => more()))
  const ok = opened.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
  const failed = opened.find((r) => r.status === 'rejected')
  if (failed) {
    await Promise.all(ok.map((h) => h.close()))
    const error = (failed as PromiseRejectedResult).reason
    const message = error instanceof Error ? error.message : String(error)
    const way = workersHint(message, hosts)
    throw way ? new Error(`${message}${way}`, { cause: error }) : error
  }
  return ok
}
