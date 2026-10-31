import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { build } from 'vite'
import { alive } from '../deliver/claim.ts'
import { packageOf } from '../project/dependencies.ts'
import { stamp } from '../stamp/plugin.ts'
import type { Project } from './project.ts'

let builds = 0
/**
 * This process's builds a host opened, by folder: how many of their hosts run. One whose hosts all
 * exited goes at the next build here (sweep), so a long MCP session keeps no pile of them. Not on
 * the exit itself: a host reopened after a failed frame (reopening) opens the same build again.
 */
const hosted = new Map<string, number>()

/** A host opened (+1) or exited (-1) on the build at `entryFile`. */
export const hostOfBuild = (entryFile: string, change: 1 | -1) => {
  const dir = dirname(entryFile)
  hosted.set(dir, (hosted.get(dir) ?? 0) + change)
}

/**
 * Rethrows a Vite build error of the project at `root` as plain text, without its colour codes: it
 * leaves the CLI for the studio page, `--json` and MCP, which cannot show them. Where Vite points
 * (`─[ file:line:col ]`, from the working directory) becomes the project's own path, and the error
 * carries it as `at` for its `build` finding (errorFinding). Every build of a film throws through it.
 */
export const plainError =
  (root: string) =>
  (e: unknown): never => {
    if (!(e instanceof Error)) throw e
    e.message = stripVTControlCharacters(e.message)
    if (e.stack) e.stack = stripVTControlCharacters(e.stack)
    const m = /─\[ (.+?):(\d+):(\d+) \]/.exec(e.message)
    if (m) {
      const file = relative(root, resolve(m[1] as string))
        .split(sep)
        .join('/')
      e.message = e.message.replace(m[1] as string, file)
      Object.assign(e, { at: { code: 'build', file, line: Number(m[2]), column: Number(m[3]) } })
    }
    throw e
  }

/**
 * Removes the builds of processes that have exited, this process's builds whose hosts all exited
 * (hosted), and the single shared build of versions before 2026-10-12 (`.shaderera/node/entry.js`). Processes that build at once (the chunks of one
 * job, in one frozen copy) all find the same exited build: each moves it aside to a name of its
 * own first, so only the one whose move succeeds removes it. Two removals of one folder at once
 * fail with EPERM on Windows (#433). What cannot be removed now (a file held open) is left for a
 * later sweep: a sweep never fails a build.
 */
const sweep = (dir: string) => {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const pid = /^(\d+)-\d+(\.removing)?$/.exec(name)?.[1]
    const done = hosted.get(join(dir, name)) === 0
    if (done) hosted.delete(join(dir, name))
    if (done || (pid ? !alive(Number(pid)) : /\.js$/.test(name))) {
      const aside = join(dir, `${process.pid}-${builds++}.removing`)
      try {
        renameSync(join(dir, name), aside)
        rmSync(aside, { recursive: true, force: true })
      } catch {}
    }
  }
}

/**
 * Builds the project's entry (and manifest.dom, for its imports) for Node with the project's own
 * Vite config: one ES module at `<root>/.shaderera/node/<pid>-<n>/entry.js`, with dependencies left
 * external (Vite's SSR default). Each build has its own folder, so two commands on one project at
 * once (a check while a still renders) never empty each other's build; folders of exited
 * processes are removed. `packages` names the installed packages the build imports, which a render
 * job freezes. A build error is plain text (plainError).
 */
export const buildNode = async (
  project: Project,
): Promise<{ entryFile: string; packages: string[] }> => {
  const dir = join(project.root, '.shaderera', 'node')
  sweep(dir)
  const outDir = join(dir, `${process.pid}-${builds++}`)
  const result = await build({
    root: project.root,
    logLevel: 'silent',
    plugins: project.manifest.stamp ? [stamp({ root: project.root })] : [],
    build: {
      ssr: true,
      outDir,
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        // manifest.dom too: the packages it imports are part of what a job freezes.
        input: {
          entry: project.manifest.entry,
          ...(project.manifest.dom ? { dom: project.manifest.dom } : {}),
        },
        output: { format: 'es', entryFileNames: '[name].js' },
      },
    },
  }).catch(plainError(project.root))
  const packages = new Set<string>()
  for (const output of Array.isArray(result) ? result : [result])
    for (const chunk of 'output' in output ? output.output : [])
      if (chunk.type === 'chunk')
        for (const specifier of [...chunk.imports, ...chunk.dynamicImports]) {
          const name = packageOf(specifier)
          if (name) packages.add(name)
        }
  return { entryFile: join(outDir, 'entry.js'), packages: [...packages].sort() }
}

export const buildForNode = async (project: Project): Promise<string> =>
  (await buildNode(project)).entryFile
