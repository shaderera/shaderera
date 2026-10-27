import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import { FILES_META, isOrigin, PARENTS_META } from '../player/parents.ts'
import { type BakeFrames, createServices, type ServiceRequest } from './services.ts'

export const RUNNER_PATH = '/__shaderera/runner.html'
const ENTRY = '/__shaderera/entry.js'
const VIRTUAL = '\0shaderera-entry'
/** manifest.dom's module, or none: the bridge mounts it on the runner page. */
const DOM = '/__shaderera/dom.js'
const VIRTUAL_DOM = '\0shaderera-dom'
/** The service token's module, which only the runner's own origin can read. */
const TOKEN = '/__shaderera/token.js'
const VIRTUAL_TOKEN = '\0shaderera-token'

const slashes = (path: string): string => path.replace(/\\/g, '/')

/**
 * The modules the runner imports by fixed ids (so Vite never rewrites a variable import() in it):
 * the project's entry, its DOM (manifest.dom, or none) and the service token's module (`token` is
 * its code).
 */
export const runnerModules = (
  entryFile: string,
  domFile: string | undefined,
  token: string,
): Pick<Plugin, 'resolveId' | 'load'> => ({
  resolveId: (id) =>
    id === ENTRY ? VIRTUAL : id === DOM ? VIRTUAL_DOM : id === TOKEN ? VIRTUAL_TOKEN : undefined,
  load: (id) =>
    id === VIRTUAL_TOKEN
      ? token
      : id === VIRTUAL
        ? `export { default } from ${JSON.stringify(slashes(entryFile))}`
        : id === VIRTUAL_DOM
          ? domFile
            ? `export { default } from ${JSON.stringify(slashes(domFile))}`
            : 'export default null'
          : undefined,
})

/**
 * Where the runner worker POSTs a frame, or the sound (runner/audio.ts), for the browser host
 * (`/__shaderera/frame/<key>`).
 */
export const FRAME_PATH = '/__shaderera/frame/'
/** The frames (and sound) the browser host is waiting for, by key: one body each, then forgotten. */
export const frameUploads = new Map<string, (bytes: Buffer) => void>()
/**
 * Where the runner worker asks the CLI's process for the cache and video frames (services.ts),
 * with the server's token: another page can send a request here but cannot read the token.
 */
export const SERVICE_PATH = '/__shaderera/service/'

/**
 * The runner origin's own page, added to the project's Vite server. Every response from this
 * server carries the runner's CSP, so the project's code can reach only its own origin and can
 * be framed only by the Studio.
 */
export const runnerPlugin = (
  pkgDir: string,
  entryFile: string,
  studioOrigins: readonly string[],
  runnerPort: number,
  domFile?: string,
  /** The bakes' frames, checked against their stamps: what io.bake reads. */
  bakes?: BakeFrames,
  /**
   * Framed by a page on another origin (the studio, docs/studio.md): the server's base, a path
   * that is a secret, outside which every request is refused. The frame is sandboxed, so its
   * origin is opaque: every file under the base is served to any origin, and the page spells out
   * the runner's own origin and starts its worker from a data: URL, as the web player does.
   */
  base?: string,
  /** A draft render's: io.video's frames scaled by this much (createServices). */
  videoScale?: number,
): Plugin => {
  const self = base ? `'self' http://127.0.0.1:${runnerPort}` : "'self'"
  const ancestors = studioOrigins.filter(isOrigin)
  const csp = [
    "default-src 'self'",
    `script-src ${self} 'wasm-unsafe-eval'`,
    `worker-src ${self} blob:${base ? ' data:' : ''}`,
    `connect-src ${self} ws://localhost:${runnerPort} ws://127.0.0.1:${runnerPort}`,
    `img-src ${self} data: blob:`,
    `font-src ${self} data: blob:`,
    "style-src 'self' 'unsafe-inline'",
    `frame-ancestors ${ancestors.length > 0 ? ancestors.join(' ') : "'none'"}`,
  ].join('; ')
  const token = randomUUID()
  const source = join(pkgDir, 'src/runner/bridge.ts')
  const bridge = existsSync(source) ? source : join(pkgDir, 'dist/runner/bridge.js')
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="${PARENTS_META}" content="${ancestors.join(' ')}">${
    base
      ? `
<meta name="${FILES_META}" content="http://127.0.0.1:${runnerPort}${base}">`
      : ''
  }
<script type="module" src="/@fs/${slashes(bridge).replace(/^\//, '')}"></script>
</head><body></body></html>`
  return {
    name: 'shaderera-runner',
    ...runnerModules(entryFile, domFile, `export default ${JSON.stringify(token)}`),
    configureServer(server) {
      const services = createServices(server.config.root, bakes, { videoScale })
      server.httpServer?.once('close', () => services.close())
      server.middlewares.use((req, res, next) => {
        res.setHeader('Content-Security-Policy', csp)
        // Under a base, the path past it; outside it, nothing (not even Vite's hint naming it).
        let path = req.url ?? '/'
        if (base) {
          if (!path.startsWith(base)) {
            res.statusCode = 403
            res.end()
            return
          }
          path = `/${path.slice(base.length)}`
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
        }
        if (path.startsWith(SERVICE_PATH)) {
          const u = new URL(path, 'http://runner')
          const op = u.pathname.slice(SERVICE_PATH.length)
          const q = (k: string) => u.searchParams.get(k) ?? ''
          if (q('token') !== token) {
            res.statusCode = 403
            res.end()
            return
          }
          const parts: Buffer[] = []
          req.on('data', (part: Buffer) => parts.push(part))
          req.on('end', () => {
            const request =
              op === 'cache-get'
                ? { op, hash: q('hash') }
                : op === 'cache-put'
                  ? { op, hash: q('hash'), bytes: new Uint8Array(Buffer.concat(parts)) }
                  : op === 'image-open'
                    ? {
                        op,
                        path: q('path'),
                        ...(q('maxSize') ? { maxSize: Number(q('maxSize')) } : {}),
                      }
                    : op === 'image-data'
                      ? { op, key: q('key') }
                      : op === 'video-open'
                        ? { op, path: q('path') }
                        : op === 'video-frame'
                          ? { op, path: q('path'), index: Number(q('index')) }
                          : op === 'video-close'
                            ? { op, path: q('path') }
                            : op === 'bake-open'
                              ? { op, name: q('name') }
                              : op === 'bake-frame'
                                ? { op, name: q('name'), index: Number(q('index')) }
                                : undefined
            if (!request) {
              res.statusCode = 400
              res.end(`unknown service ${op}`)
              return
            }
            services
              .handle(request as ServiceRequest)
              .then((result) => {
                if (result === null) {
                  res.statusCode = op === 'cache-put' || op === 'video-close' ? 204 : 404
                  return res.end()
                }
                if (result instanceof Uint8Array) {
                  res.setHeader('Content-Type', 'application/octet-stream')
                  return res.end(Buffer.from(result.buffer, result.byteOffset, result.byteLength))
                }
                res.setHeader('Content-Type', 'application/json')
                res.end(JSON.stringify(result))
              })
              .catch((e: unknown) => {
                res.statusCode = 500
                res.end(e instanceof Error ? e.message : String(e))
              })
          })
          return
        }
        if (req.method === 'POST' && path.startsWith(FRAME_PATH)) {
          // Only a key the host is waiting for is taken; anything else is refused unread.
          const done = frameUploads.get(path.slice(FRAME_PATH.length))
          if (!done) {
            res.statusCode = 404
            res.end()
            return
          }
          frameUploads.delete(path.slice(FRAME_PATH.length))
          const parts: Buffer[] = []
          req.on('data', (part: Buffer) => parts.push(part))
          req.on('end', () => {
            done(Buffer.concat(parts))
            res.statusCode = 204
            res.end()
          })
          return
        }
        if (path.split('?')[0] !== RUNNER_PATH) return next()
        server
          .transformIndexHtml(RUNNER_PATH, html)
          .then((out) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(out)
          })
          .catch(next)
      })
    },
  }
}
