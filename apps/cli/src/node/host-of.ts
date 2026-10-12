import type { Manifest } from '@shaderera/core'

export type HostName = 'node' | 'browser'

/**
 * The host a run opens: `--host` when given, else the manifest's `host`, else Node. A project with
 * a DOM cannot be forced into the Node host, which cannot draw it.
 */
export const hostOf = (manifest: Manifest, flag?: unknown): HostName => {
  if (flag === undefined) return manifest.host ?? 'node'
  if (flag !== 'node' && flag !== 'browser')
    throw new Error(`--host is node or browser, not ${String(flag)}.`)
  if (flag === 'node' && manifest.dom !== undefined)
    throw new Error(
      'This project has a DOM (manifest.dom), which only the browser host draws: --host node cannot render it.',
    )
  return flag
}
