// The runner page's script on the runner server: starts the worker and hands the framing page a
// port to it (page.ts), or, unframed (the browser host: a project with `"host": "browser"`), puts
// the worker's API on `window.__shaderera` for the host to drive.
//
// The framing page is one of the origins the page's `shaderera-parents` meta lists: the one
// `?parent=` names, else the first (player/parents.ts). Framed by the studio (docs/studio.md), the
// frame is sandboxed and its origin opaque: the `shaderera-files` meta names the runner's files,
// and the worker starts from a data: URL that imports it and points it there, as the web player's
// does (player/bridge.ts).
import { FILES_META, PARENTS_META, parentOrigin } from '../player/parents.ts'
import { connectPage } from './page.ts'

const meta = (name: string) =>
  document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content
const allowed = (meta(PARENTS_META) ?? '').split(/\s+/).filter(Boolean)
const origin =
  parent === window
    ? undefined
    : parentOrigin(allowed, new URLSearchParams(location.search).get('parent'))
const files = meta(FILES_META)
// The studio's `/runner?variant=`: the variant the worker opens when the page names none.
const variant = new URLSearchParams(location.search).get('variant')
// Framed with an opaque origin, Vite's client cannot make the SharedWorker it pings with once the
// CLI stops (a SecurityError); without one it pings from the page.
if (files) Reflect.deleteProperty(globalThis, 'SharedWorker')
const at = new URL(import.meta.url.replace(/bridge\.(ts|js)/, 'worker.$1')).href
const worker = files
  ? new Worker(
      `data:text/javascript,${encodeURIComponent(
        `import { configureRunner } from ${JSON.stringify(at)}; configureRunner(${JSON.stringify({ files, ...(variant !== null ? { variant } : {}) })});`,
      )}`,
      { type: 'module' },
    )
  : new Worker(at, { type: 'module' })
worker.addEventListener('error', (e) => {
  const message = e.message || 'The runner worker failed to load.'
  if (origin !== undefined) parent.postMessage({ shaderera: 'error', message }, origin)
  else console.error(message)
})
connectPage(worker, origin)
