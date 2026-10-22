// The web player's page script (runner.html): starts the runner worker and hands the framing page
// a port to it, as the runner server's bridge does (runner/page.ts). docs/player.md is the
// protocol. What differs:
// - the framing page's origin is one of those runner.html allows (`shaderera-parents`);
// - the worker starts from a data: URL that imports it by its full URL. A frame sandboxed with
//   "allow-scripts" alone has an opaque origin, and `new Worker(url)` refuses a URL of any other
//   origin (a blob: URL failed too in Chrome); the imported worker keeps its own import.meta.url.
//   On a version's own origin ("allow-same-origin", decision 0024) Chrome still keeps the
//   shaders this worker compiles: measured with MATTER, 16 s cold, then 0.1 s;
// - a worker that fails to load is reported to the framing page, which would otherwise wait;
// - a viewer's file for a clip param goes on to the worker, from the framing page only.
import { connectPage } from '../runner/page.ts'
import { fileFrom, PARENTS_META, parentOrigin } from './parents.ts'

const allowed = (
  document.querySelector<HTMLMetaElement>(`meta[name="${PARENTS_META}"]`)?.content ?? ''
)
  .split(/\s+/)
  .filter(Boolean)
const origin =
  parent === window
    ? undefined
    : parentOrigin(allowed, new URLSearchParams(location.search).get('parent'))

const here = import.meta.url
const at = new URL(here.replace(/bridge\.js$/, 'worker.js')).href
const worker = new Worker(
  `data:text/javascript,${encodeURIComponent(`import ${JSON.stringify(at)};`)}`,
  { type: 'module' },
)
worker.addEventListener('error', (e) => {
  const message = e.message || 'The player worker failed to load.'
  if (origin !== undefined) parent.postMessage({ shaderera: 'error', message }, origin)
  else console.error(message)
})
addEventListener('message', (e) => {
  const file = fileFrom(e, parent, origin)
  if (file) worker.postMessage({ shadereraFile: file })
})
connectPage(worker, origin)
