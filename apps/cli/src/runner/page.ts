// The runner page's half, whichever page starts the worker (bridge.ts on the runner server, the
// web player's bridge): it hands the framing page a port to the worker, or, unframed, puts the
// worker's API on `window.__shaderera`; and it lays out and draws the project's DOM (dom.ts).
import * as Comlink from 'comlink'
import { domHost } from './dom.ts'

/**
 * Connects a started runner worker. Framed, the port goes to `parentOrigin` only (the browser
 * delivers it to no other origin), and a reload says "reloading" first.
 */
export const connectPage = (worker: Worker, parentOrigin: string | undefined): void => {
  const { port1, port2 } = new MessageChannel()
  worker.postMessage({ connect: port1 }, [port1])
  const dom = new MessageChannel()
  worker.postMessage({ dom: dom.port1 }, [dom.port1])
  domHost(dom.port2)
  if (parent === window) {
    ;(window as unknown as { __shaderera: unknown }).__shaderera = Comlink.wrap(port2)
  } else if (parentOrigin !== undefined) {
    parent.postMessage({ shaderera: 'runner' }, parentOrigin, [port2])
    addEventListener('beforeunload', () =>
      parent.postMessage({ shaderera: 'reloading' }, parentOrigin),
    )
  }
}
