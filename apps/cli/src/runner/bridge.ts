// The runner page's script: starts the worker and hands the Studio a port to it. Vite reloads
// this page when a project file changes; the Studio hears "reloading", then gets a new port and
// re-opens. Unframed (the browser host: a project with `"host": "browser"`), it puts the worker's API on
// `window.__shaderera` for the host to drive. It also lays out the project's DOM (manifest.dom)
// and draws it at the worker's t (dom.ts).
import * as Comlink from 'comlink'
import { domHost } from './dom.ts'

const studio = document.querySelector<HTMLMetaElement>('meta[name="shaderera-studio"]')?.content
const worker = new Worker(new URL(import.meta.url.replace(/bridge\.(ts|js)/, 'worker.$1')), {
  type: 'module',
})
const { port1, port2 } = new MessageChannel()
worker.postMessage({ connect: port1 }, [port1])
const dom = new MessageChannel()
worker.postMessage({ dom: dom.port1 }, [dom.port1])
domHost(dom.port2)
if (parent === window) {
  ;(window as unknown as { __shaderera: unknown }).__shaderera = Comlink.wrap(port2)
} else if (studio !== undefined) {
  parent.postMessage({ shaderera: 'runner' }, studio, [port2])
  addEventListener('beforeunload', () => parent.postMessage({ shaderera: 'reloading' }, studio))
}
