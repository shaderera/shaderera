import { createServer as createNetServer } from 'node:net'
import { resolve } from 'node:path'
import { stamp } from '../stamp/plugin.ts'
import type { Project } from './project.ts'
import { runnerPlugin } from './runner-plugin.ts'
import type { BakeFrames } from './services.ts'

export const HOST = '127.0.0.1'

/** The first port at or above `from` that is free on loopback. */
export const freePort = async (from: number): Promise<number> => {
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

/**
 * The project's own Vite server, the runner: its page (runner-plugin.ts) under the runner's CSP,
 * framed by the Studio at `studioOrigins`, or opened alone by the browser host.
 */
export const startRunner = async (
  project: Project,
  o: {
    pkgDir: string
    studioOrigins: readonly string[]
    port: number
    /** Vite's dependency cache; hosts running at once each need their own. */
    cacheDir?: string
    /** The bakes' frames, checked against their stamps: what io.bake reads. */
    bakes?: BakeFrames
  },
) => {
  const vite = await import('vite')
  const runner = await vite.createServer({
    root: project.root,
    appType: 'custom',
    clearScreen: false,
    ...(o.cacheDir ? { cacheDir: o.cacheDir } : {}),
    logLevel: 'warn',
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
      ),
    ],
    optimizeDeps: { exclude: ['comlink', '@shaderera/core'] },
    server: {
      host: HOST,
      port: o.port,
      strictPort: true,
      fs: { allow: [vite.searchForWorkspaceRoot(project.root), o.pkgDir] },
      hmr: { host: HOST, port: o.port, clientPort: o.port },
      // Frozen revisions, agent stages and renders are written under the root; none is the
      // project the preview shows, so none may reload it.
      watch: { ignored: ['**/.shaderera/**', '**/versions/**', '**/out/**'] },
    },
  })
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
