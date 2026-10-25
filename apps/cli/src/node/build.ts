import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { build } from 'vite'
import { packageOf } from '../project/dependencies.ts'
import { stamp } from '../stamp/plugin.ts'
import type { Project } from './project.ts'

let builds = 0

/** Whether a process is still running. */
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: it runs, as another user.
    return (e as { code?: string }).code === 'EPERM'
  }
}

/**
 * Rethrows a Vite build error as plain text, without its colour codes: it leaves the CLI for the
 * studio page, `--json` and MCP, which cannot show them. Every build of a film throws through it.
 */
export const plainError = (e: unknown): never => {
  if (e instanceof Error) {
    e.message = stripVTControlCharacters(e.message)
    if (e.stack) e.stack = stripVTControlCharacters(e.stack)
  }
  throw e
}

/**
 * Removes the builds of processes that have exited, and the single shared build of versions
 * before 2026-10-12 (`.shaderera/node/entry.js`). Processes that build at once (the chunks of one
 * job, in one frozen copy) all find the same exited build: each moves it aside to a name of its
 * own first, so only the one whose move succeeds removes it. Two removals of one folder at once
 * fail with EPERM on Windows (#433). What cannot be removed now (a file held open) is left for a
 * later sweep: a sweep never fails a build.
 */
const sweep = (dir: string) => {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const pid = /^(\d+)-\d+(\.removing)?$/.exec(name)?.[1]
    if (pid ? !alive(Number(pid)) : /\.js$/.test(name)) {
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
    logLevel: 'warn',
    plugins: project.manifest.stamp ? [stamp({ root: project.root })] : [],
    build: {
      ssr: true,
      outDir,
      emptyOutDir: true,
      rollupOptions: {
        // manifest.dom too: the packages it imports are part of what a job freezes.
        input: {
          entry: project.manifest.entry,
          ...(project.manifest.dom ? { dom: project.manifest.dom } : {}),
        },
        output: { format: 'es', entryFileNames: '[name].js' },
      },
    },
  }).catch(plainError)
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
