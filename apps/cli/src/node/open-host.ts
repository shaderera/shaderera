import type { Json, Range } from '@shaderera/core'
import { openBrowserChild } from './browser.ts'
import { type Child, openChild } from './child.ts'
import type { HostName } from './host-of.ts'
import type { Project } from './project.ts'
import { withRetries } from './retry.ts'
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
  /** A draft render's (render --draft): clips come from the decoder scaled by this much. */
  videoScale?: number
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
    ...(o.videoScale ? { videoScale: o.videoScale } : {}),
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
    openChild(sized, {
      ...common,
      entryFile: built.entryFile,
      trusted: o.trusted === true,
      ...(o.size ? { resized: true } : {}),
    })
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

/** A host gone (crashed, killed after a timeout, its Chrome closed), not a source's own error. */
const GONE =
  /The source process (has )?exited|The source took longer than|The browser host took longer than|The browser host's Chrome closed/

/**
 * A host failure a fresh host may not repeat: the host gone (GONE) or its GPU device lost or out
 * of memory (DEVICE). A source's own throw or a shader that does not compile fails again.
 */
export const transientHost = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return GONE.test(message) || DEVICE.test(message)
}

/**
 * `first` as a host whose frame render, on a transient failure (transientHost), closes it, opens
 * another from `more` and renders the frame again, up to `retries` times (withRetries). Its other
 * calls go to the host open now. A source gives the same bytes at t on any host (determinism), so
 * a retried frame is the frame an uninterrupted render gives. Close it instead of `first`.
 */
export const reopening = (
  first: Child,
  more: () => Promise<Child>,
  o: { retries: number; fps: number; delayMs?: number; signal?: AbortSignal },
): Child => {
  let host = first
  // Which host the calls go to: a call that failed on an earlier one reopens nothing.
  let generation = 0
  let ready: Promise<void> = Promise.resolve()
  const reopen = (failed: number) => {
    if (failed === generation) {
      generation++
      const old = host
      ready = (async () => {
        await old.close().catch(() => {})
        host = await more()
      })()
    }
    return ready
  }
  const current = async () => {
    await ready
    return host
  }
  return {
    has: first.has,
    render: (t, intent, format) => {
      let at = generation
      return withRetries(
        async () => {
          const h = await current()
          at = generation
          return h.render(t, intent, format)
        },
        {
          retries: o.retries,
          transient: transientHost,
          what: `Frame ${Math.round(t * o.fps)} (t ${t} s)`,
          how: 'on a reopened host',
          before: () => reopen(at),
          ...(o.delayMs !== undefined ? { delayMs: o.delayMs } : {}),
          ...(o.signal ? { signal: o.signal } : {}),
        },
      )
    },
    inspect: async (t) => (await current()).inspect(t),
    pick: async (t, x, y) => (await current()).pick(t, x, y),
    camera: async (t) => (await current()).camera(t),
    override: async (m) => (await current()).override(m),
    audio: async () => (await current()).audio(),
    captions: async () => (await current()).captions(),
    fonts: async () => (await current()).fonts(),
    identity: async () => (await current()).identity(),
    clock: async () => (await current()).clock(),
    profile: async (reset) => (await current()).profile(reset),
    seeks: async () => (await current()).seeks(),
    text: async (t) => (await current()).text(t),
    close: async () => {
      await ready.catch(() => {})
      await host.close()
    },
  }
}
