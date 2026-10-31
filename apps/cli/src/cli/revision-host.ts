import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Json } from '@shaderera/core'
import { openRevision } from '../project/jobs.ts'
import { readRevision, revisionOf } from '../project/revisions.ts'

type Opened = Awaited<ReturnType<typeof openRevision>>

/** How long a kept revision host waits unused before it closes. */
export const IDLE_MS = 5 * 60_000

/**
 * The host of the last revision an MCP call asked for (`render_frame`, `still` with `revision`),
 * kept open for the next call on the same revision, variant and params: an agent looks several
 * times at the revision a comment names. Another revision closes it first, so one is open at most;
 * it also closes `idleMs` after a call on it ended (`rest`) with none since, and when `drop` is called (a call on it failed). The frozen
 * copies it leaves stay bounded by the pool's trim (revisions.ts).
 */
export const revisionHosts = (o: {
  host?: unknown
  trusted?: boolean
  timeoutMs?: number
  idleMs?: number
  open?: typeof openRevision
}) => {
  const opener = o.open ?? openRevision
  const idleMs = o.idleMs ?? IDLE_MS
  let kept: { key: string; opened: Promise<Opened> } | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  const drop = async () => {
    clearTimeout(idle)
    const was = kept
    kept = undefined
    await was?.opened.then((r) => r.close()).catch(() => {})
  }
  const get = async (
    root: string,
    given: string,
    variant: string | undefined,
    params: { readonly [key: string]: Json } | undefined,
  ): Promise<Opened> => {
    clearTimeout(idle)
    const revision = revisionOf(root, given)
    const key = JSON.stringify([root, revision, variant ?? null, params ?? null])
    // Pruned (or removed) since it opened: the open copy is not that revision any more.
    if (kept?.key === key && !existsSync(join(root, 'versions', 'revisions', `${revision}.json`))) {
      await drop()
      readRevision(root, revision)
    }
    if (kept?.key !== key) {
      await drop()
      const opened = opener(root, revision, {
        host: o.host,
        trusted: o.trusted,
        timeoutMs: o.timeoutMs,
        variant,
        params,
      })
      kept = { key, opened }
      opened.catch(() => {
        if (kept?.opened === opened) kept = undefined
      })
    }
    return (kept as { opened: Promise<Opened> }).opened
  }
  /** The call on it ended: it closes if no call comes within `idleMs`. */
  const rest = () => {
    clearTimeout(idle)
    if (!kept) return
    idle = setTimeout(() => void drop(), idleMs)
    idle.unref()
  }
  return { get, drop, rest }
}
