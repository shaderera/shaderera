// The web player: a film as static files any host can serve and a sandboxed frame on another origin
// can play (docs/player.md). It is the runner the CLI serves from the project's Vite server
// (node/runner-plugin.ts), built instead: the runner page and worker with the film's entry and its
// npm dependencies bundled, and what the CLI's process would answer (io.video, io.bake) made
// ahead, so the browser answers it (services.ts).
//
//   runner.html           the page a site frames; it starts assets/bridge.js
//   assets/bridge.js      starts the worker, hands the framing page a port to it (bridge.ts)
//   assets/worker.js      the runner worker: the only caller of the film's Source (worker.ts)
//   assets/chunks/*       the film's entry, its dependencies and the engine's shared code
//   assets/THIRD-PARTY-NOTICES.txt  the licence notices of every package it bundles (notices.ts)
//   files/<path>          the film's files, as a share sends them, for io.read
//   media/<path>.mp4      for each video among them, an H.264 proxy io.video decodes (media.ts)
//   media/<path>.json     its width, height, fps and frame count, as io.video reads the original
//   bakes/<name>/<frame>  each bake's frames, checked against its stamp, for io.bake
//   bakes/<name>.json     their file names in order
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { plainError } from '../node/build.ts'
import type { Project } from '../node/project.ts'
import { runnerModules } from '../node/runner-plugin.ts'
import { checkBakes } from '../project/bakes.ts'
import { slash } from '../project/revisions.ts'
import { stamp } from '../stamp/plugin.ts'
import { makeProxy, VIDEO } from './media.ts'
import { NOTICES_FILE, thirdPartyNotices } from './notices.ts'
import { DEFAULT_PARENTS, isOrigin, PARENTS_META } from './parents.ts'

export type PlayerOptions = {
  /** Where the player goes; emptied first. */
  outDir: string
  /** The film's files the player carries for io.read, as project paths (a share's `files`). */
  files: readonly string[]
  /**
   * The origins that may frame the player and get its port (the site's), `https://shaderera.com`
   * by default. The page names one with `?parent=`; the first is used otherwise.
   */
  parents?: readonly string[]
}

export type Player = {
  /** Every file written, relative to outDir, with forward slashes, sorted. */
  files: string[]
  bytes: number
}

const pkgDir = fileURLToPath(new URL('../..', import.meta.url))
/** The runner's source in this repository, its build in the published package. */
const engineFile = (name: string) => {
  const source = join(pkgDir, 'src', 'player', `${name}.ts`)
  return existsSync(source) ? source : join(pkgDir, 'dist', 'player', `${name}.js`)
}

/**
 * The runner's fixed modules for this film, and no service token: nothing in a player asks the
 * runner server. Rolldown marks each module with `//#region <path>`, a path relative to where the
 * build ran: the same film built in another folder would differ, so those lines are dropped. Once
 * bundled, the notices of every package the chunks hold are written beside them (notices.ts).
 */
const playerPlugin = (project: Project): Plugin => ({
  name: 'shaderera-player',
  enforce: 'pre',
  ...runnerModules(
    resolve(project.root, project.manifest.entry),
    project.manifest.dom === undefined ? undefined : resolve(project.root, project.manifest.dom),
    "throw new Error('A web player has no CLI process behind it.')",
  ),
  renderChunk: (code) => code.replace(/^\/\/#(?:end)?region\b.*\r?\n/gm, ''),
  generateBundle(_, bundle) {
    const ids = Object.values(bundle).flatMap((c) => (c.type === 'chunk' ? c.moduleIds : []))
    this.emitFile({
      type: 'asset',
      fileName: NOTICES_FILE,
      source: thirdPartyNotices(ids, project.root),
    })
  },
})

const page = (parents: readonly string[]) => `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="${PARENTS_META}" content="${parents.join(' ')}">
<!-- The licence notices of what this player bundles: ${NOTICES_FILE} -->
<script type="module" src="./assets/bridge.js"></script>
</head><body></body></html>
`

/**
 * Builds the film's web player into `outDir`. Its bakes are checked first, and every proxy against
 * its original; any failure throws, and leaves no player behind.
 */
export const buildPlayer = async (project: Project, o: PlayerOptions): Promise<Player> => {
  const { root, manifest } = project
  const parents = o.parents ?? DEFAULT_PARENTS
  if (parents.length === 0) throw new Error('A player needs at least one parent origin.')
  for (const p of parents)
    if (!isOrigin(p)) throw new Error(`Not an origin (scheme, host and port only): ${p}`)
  const outDir = resolve(o.outDir)
  rmSync(outDir, { recursive: true, force: true })
  const bakes = checkBakes(root, manifest)
  try {
    const { build } = await import('vite')
    await build({
      root,
      // Relative URLs: a site serves the player under a path of its own, never at its root.
      base: './',
      publicDir: false,
      logLevel: 'warn',
      plugins: [playerPlugin(project), ...(manifest.stamp ? [stamp({ root })] : [])],
      build: {
        outDir,
        emptyOutDir: true,
        target: 'esnext',
        modulePreload: false,
        minify: false,
        rollupOptions: {
          input: { bridge: engineFile('bridge'), worker: engineFile('worker') },
          preserveEntrySignatures: 'strict',
          output: {
            format: 'es',
            // The bridge finds the worker by its own name (bridge.js → worker.js): no hash on them.
            entryFileNames: 'assets/[name].js',
            // Nor on chunks: a player's URLs never change, and the worker, which imports the
            // film's entry chunk by name, is then the same file for every film of this
            // shaderera, which a site stores and a share uploads once.
            chunkFileNames: 'assets/chunks/[name].js',
            assetFileNames: 'assets/chunks/[name]-[hash][extname]',
          },
        },
      },
    }).catch(plainError(root))
    writeFileSync(join(outDir, 'runner.html'), page(parents))
    for (const file of o.files) {
      const to = join(outDir, 'files', file)
      mkdirSync(dirname(to), { recursive: true })
      cpSync(join(root, file), to)
      if (VIDEO.test(file)) {
        const proxy = join(outDir, 'media', `${file}.mp4`)
        mkdirSync(dirname(proxy), { recursive: true })
        const info = makeProxy(join(root, file), proxy)
        writeFileSync(join(outDir, 'media', `${file}.json`), `${JSON.stringify(info)}\n`)
      }
    }
    for (const [name, frames] of Object.entries(bakes)) {
      const dir = join(outDir, 'bakes', name)
      mkdirSync(dir, { recursive: true })
      for (const frame of frames) cpSync(frame, join(dir, basename(frame)))
      writeFileSync(
        join(outDir, 'bakes', `${name}.json`),
        `${JSON.stringify({ frames: frames.map((f) => basename(f)) })}\n`,
      )
    }
  } catch (error) {
    rmSync(outDir, { recursive: true, force: true })
    throw error
  }
  const files: string[] = []
  let bytes = 0
  for (const e of readdirSync(outDir, { recursive: true, withFileTypes: true }))
    if (e.isFile()) {
      const full = join(e.parentPath, e.name)
      files.push(slash(relative(outDir, full)))
      bytes += statSync(full).size
    }
  return { files: files.sort(), bytes }
}
