// The runner page's script on the runner server: starts the worker and hands the Studio a port to
// it (page.ts). Vite reloads this page when a project file changes; the Studio hears "reloading",
// then gets a new port and re-opens. Unframed (the browser host: a project with
// `"host": "browser"`), it puts the worker's API on `window.__shaderera` for the host to drive.
import { connectPage } from './page.ts'

const studio = document.querySelector<HTMLMetaElement>('meta[name="shaderera-studio"]')?.content
const worker = new Worker(new URL(import.meta.url.replace(/bridge\.(ts|js)/, 'worker.$1')), {
  type: 'module',
})
connectPage(worker, studio)
