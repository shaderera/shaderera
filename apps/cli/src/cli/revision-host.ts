import type { Json } from '@shaderera/core'
import { openRevision } from '../project/jobs.ts'

type Opened = Awaited<ReturnType<typeof openRevision>>

/**
 * The host of the last revision an MCP call asked for (`render_frame`, `still` with `revision`),
 * kept open for the next call on the same revision, variant and params: an agent looks several
 * times at the revision a comment names. Another revision closes it first, so one is open at most;
 * the frozen copies it leaves stay bounded by the pool's trim (revisions.ts).
 */
export const revisionHosts = (o: { host?: unknown; trusted?: boolean; timeoutMs?: number }) => {
  let kept: { key: string; opened: Promise<Opened> } | undefined
  const drop = async () => {
    const was = kept
    kept = undefined
    await was?.opened.then((r) => r.close()).catch(() => {})
  }
  const get = async (
    root: string,
    revision: string,
    variant: string | undefined,
    params: { readonly [key: string]: Json } | undefined,
  ): Promise<Opened> => {
    const key = JSON.stringify([root, revision, variant ?? null, params ?? null])
    if (kept?.key !== key) {
      await drop()
      const opened = openRevision(root, revision, { ...o, variant, params })
      kept = { key, opened }
      opened.catch(() => {
        if (kept?.opened === opened) kept = undefined
      })
    }
    return (kept as { opened: Promise<Opened> }).opened
  }
  return { get, drop }
}
