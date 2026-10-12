import { type FSWatcher, watch } from 'node:fs'
import { open } from '../cli/args.ts'
import type { Child } from './child.ts'
import type { Project } from './project.ts'

export type Opened = { project: Project; child: Child }
export type NodeSession = { open(): Promise<Opened>; drop(): void; close(): void }

/**
 * Paths under the root that are not the project's: installs, builds, renders, saved revisions
 * (versions/: saving one is not an edit), and the log folder
 * NVIDIA's driver creates in a GPU process's working directory (the child runs in the root). A
 * change there must not close a child that is answering a call.
 */
export const notProject = (file: string): boolean =>
  /^(node_modules|\.shaderera|out|versions|NVIDIA Corporation)([\\/]|$)/.test(file)

/**
 * One cached Node child for a project, with the project as it was read when the child opened.
 * Both are dropped together, and lazily rebuilt, when a project file changes (shaderera.json too).
 */
export const createNodeSession = (
  root: string,
  o: { trusted?: boolean; timeout?: string } = {},
): NodeSession => {
  let opened: Promise<Opened> | null = null
  const drop = () => {
    opened?.then(({ child }) => child.close()).catch(() => {})
    opened = null
  }
  const watcher: FSWatcher = watch(root, { recursive: true }, (_, file) => {
    if (file && !notProject(file)) drop()
  })
  return {
    open: () => {
      opened ??= open({ root, trusted: o.trusted, timeout: o.timeout })
      const current = opened
      current.catch(() => {
        if (opened === current) opened = null
      })
      return current
    },
    drop,
    close: () => {
      watcher.close()
      drop()
    },
  }
}
