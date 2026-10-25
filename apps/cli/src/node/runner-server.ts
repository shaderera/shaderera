import { existsSync } from 'node:fs'
import { createServer as createNetServer } from 'node:net'
import { join, resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { Logger } from 'vite'
import { stamp } from '../stamp/plugin.ts'
import type { Project } from './project.ts'
import { runnerPlugin } from './runner-plugin.ts'
import type { BakeFrames } from './services.ts'

export const HOST = '127.0.0.1'

/** The first port at or above `from` that is free on loopback. */
const freePort = async (from: number): Promise<number> => {
  for (let port = from; port < from + 100; port++) {
    const free = await new Promise<boolean>((done) => {
      const probe = createNetServer()
      probe.once('error', () => done(false))
      probe.listen(port, HOST, () => probe.close(() => done(true)))
    })
    if (free) return port
  }
  throw new Error(`No free port from ${from}.`)
}

type RunnerOptions = {
  pkgDir: string
  studioOrigins: readonly string[]
  /** Vite's dependency cache; hosts running at once each need their own. */
  cacheDir?: string
  /** The bakes' frames, checked against their stamps: what io.bake reads. */
  bakes?: BakeFrames
  /**
   * For the studio (docs/studio.md): served under this secret path only, to a sandboxed frame on
   * a page of `studioOrigins`. That page reloads the frame when the project changes (no HMR).
   */
  base?: string
  /**
   * Where Vite's warnings and errors go, the page's console among them (Vite forwards its errors
   * and warnings): the studio's log. Without it, Vite prints them and forwards no console (the
   * browser host reads the page's console itself).
   */
  log?: (level: 'warn' | 'error', text: string) => void
}

/**
 * A browser extension's URL (`chrome-extension://`, `moz-extension://`, `safari-web-extension://`),
 * also as Vite writes it in an error's stack, as a path (`chrome-extension:/`).
 */
const EXTENSION = /\b[a-z-]+-extension:\//i

/**
 * Vite's logger, to `log`: its warnings and errors as plain text, but those from a browser
 * extension in the page (MetaMask's, say), which are not the film's.
 */
const loggerTo = (log: NonNullable<RunnerOptions['log']>): Logger => {
  const logged = new WeakSet<object>()
  const warned = new Set<string>()
  const say = (level: 'warn' | 'error', msg: string) => {
    const text = stripVTControlCharacters(msg)
    if (!EXTENSION.test(text)) log(level, text)
  }
  const logger: Logger = {
    hasWarned: false,
    info: () => {},
    warn: (msg) => {
      logger.hasWarned = true
      say('warn', msg)
    },
    warnOnce: (msg) => {
      if (warned.has(msg)) return
      warned.add(msg)
      logger.warn(msg)
    },
    error: (msg, options) => {
      if (options?.error) logged.add(options.error)
      say('error', msg)
    },
    clearScreen: () => {},
    hasErrorLogged: (error) => logged.has(error),
  }
  return logger
}

/**
 * The project's own Vite server, the runner: its page (runner-plugin.ts) under the runner's CSP,
 * framed by the Studio at `studioOrigins`, or opened alone by the browser host. It listens on the
 * first free port from 5300. A port can be taken between the probe and the listen (hosts and
 * test files started in parallel): the next one then.
 */
export const startRunner = async (project: Project, o: RunnerOptions) => {
  let port = await freePort(5300)
  for (let tries = 0; ; tries++) {
    try {
      return { server: await listen(project, { ...o, port }), port }
    } catch (error) {
      // Vite's strictPort throws a plain "Port N is already in use".
      if (tries >= 20 || !/already in use|EADDRINUSE/.test(String(error))) throw error
      port = await freePort(port + 1)
    }
  }
}

const listen = async (project: Project, o: RunnerOptions & { port: number }) => {
  const vite = await import('vite')
  // Vite ends the process itself, at once, on SIGTERM and when stdin ends. The command that
  // started the runner owns its end and its cleanup (the studio's `ended`, a render's partials):
  // the handlers Vite adds are taken off again.
  const sigterm = new Set(process.listeners('SIGTERM'))
  const stdinEnd = new Set(process.stdin.listeners('end'))
  const runner = await vite.createServer({
    root: project.root,
    appType: 'custom',
    clearScreen: false,
    ...(o.cacheDir ? { cacheDir: o.cacheDir } : {}),
    logLevel: 'warn',
    ...(o.log ? { customLogger: loggerTo(o.log) } : {}),
    plugins: [
      ...(project.manifest.stamp ? [stamp({ root: project.root })] : []),
      runnerPlugin(
        o.pkgDir,
        resolve(project.root, project.manifest.entry),
        o.studioOrigins,
        o.port,
        project.manifest.dom === undefined
          ? undefined
          : resolve(project.root, project.manifest.dom),
        o.bakes,
        o.base,
      ),
    ],
    ...(o.base ? { base: o.base } : {}),
    optimizeDeps: {
      exclude: ['comlink', '@shaderera/core'],
      // Installed, the runner is the package's dist/ inside node_modules, whose imports Vite never
      // pre-bundles: jpeg-js, the worker's one CommonJS dependency (runner/image.ts), would reach
      // the browser as it is and fail the worker. From this repository Vite finds it itself.
      ...(existsSync(join(o.pkgDir, 'src/runner/bridge.ts'))
        ? {}
        : { include: ['shaderera > jpeg-js'] }),
    },
    server: {
      host: HOST,
      port: o.port,
      strictPort: true,
      fs: { allow: [vite.searchForWorkspaceRoot(project.root), o.pkgDir] },
      // A framed runner's requests come from an opaque origin: the plugin answers them itself.
      ...(o.base ? { cors: false } : {}),
      hmr: o.base ? false : { host: HOST, port: o.port, clientPort: o.port },
      // Set either way: Vite's default turns it on only when an agent runs the CLI.
      forwardConsole: o.log ? { unhandledErrors: true, logLevels: ['error', 'warn'] } : false,
      // Frozen revisions, agent stages and renders are written under the root; none is the
      // project the preview shows, so none may reload it.
      watch: { ignored: ['**/.shaderera/**', '**/versions/**', '**/out/**'] },
    },
  })
  for (const l of process.listeners('SIGTERM')) if (!sigterm.has(l)) process.off('SIGTERM', l)
  for (const l of process.stdin.listeners('end'))
    if (!stdinEnd.has(l)) process.stdin.off('end', l as () => void)
  try {
    await runner.listen()
  } catch (error) {
    // A port taken between the probe and the listen: the server's watcher would keep the process
    // alive after every test passed (measured: test files killed at the 900 s timeout).
    await runner.close()
    throw error
  }
  return runner
}
