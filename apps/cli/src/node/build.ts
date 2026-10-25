import { existsSync, readdirSync, rmSync } from 'node:fs'
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
 * Removes the builds of processes that have exited, and the single shared build of versions
 * before 2026-10-12 (`.shaderera/node/entry.js`).
 */
const sweep = (dir: string) => {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const pid = /^(\d+)-\d+$/.exec(name)?.[1]
    if (pid ? !alive(Number(pid)) : /\.js$/.test(name))
      rmSync(join(dir, name), { recursive: true, force: true })
  }
}

/**
 * Builds the project's entry (and manifest.dom, for its imports) for Node with the project's own
 * Vite config: one ES module at `<root>/.shaderera/node/<pid>-<n>/entry.js`, with dependencies left
 * external (Vite's SSR default). Each build has its own folder, so two commands on one project at
 * once (a check while a still renders) never empty each other's build; folders of exited
 * processes are removed. `packages` names the installed packages the build imports, which a render
 * job freezes. A build error's message is plain text, without Vite's colour codes: it leaves the
 * CLI for the studio page, `--json` and MCP, which cannot show them.
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
  }).catch((e: unknown) => {
    if (e instanceof Error) {
      e.message = stripVTControlCharacters(e.message)
      if (e.stack) e.stack = stripVTControlCharacters(e.stack)
    }
    throw e
  })
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
