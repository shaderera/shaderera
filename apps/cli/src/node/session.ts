import { type FSWatcher, statSync, watch } from 'node:fs'
import { join } from 'node:path'
import { open } from '../cli/args.ts'
import type { Child } from './child.ts'
import type { Project } from './project.ts'

export type Opened = { project: Project; child: Child }
export type NodeSession = {
  open(): Promise<Opened>
  /** Closes the child (resolved once it and its clip decoders have exited); the next open reopens. */
  drop(): Promise<void>
  close(): void
}

/**
 * Paths under the root that are not the project's: installs, builds, renders, saved revisions
 * (versions/: saving one is not an edit), and the log folder
 * NVIDIA's driver creates in a GPU process's working directory (the child runs in the root). A
 * change there must not close a child that is answering a call.
 */
export const notProject = (file: string): boolean =>
  /^(node_modules|\.shaderera|out|versions|NVIDIA Corporation)([\\/]|$)/.test(file)

/**
 * One cached Node child for a project (`variant` and `host` as the CLI's flags), with the project
 * as it was read when the child opened.
 * Both are dropped together, and lazily rebuilt, when a project file changes (shaderera.json too).
 */
export const createNodeSession = (
  root: string,
  o: { trusted?: boolean; timeout?: string; variant?: string; host?: string } = {},
): NodeSession => {
  let opened: Promise<Opened> | null = null
  let since = 0
  const drop = async () => {
    const was = opened
    opened = null
    await was?.then(({ child }) => child.close()).catch(() => {})
  }
  // On Windows a read reports `change` too, once it moves the access time (NTFS updates it when
  // the last one is an hour old), so a change counts only when the file was modified since the
  // child opened. A file that was added, removed or renamed always counts.
  const edited = (event: string, file: string) => {
    if (event !== 'change') return true
    try {
      return statSync(join(root, file)).mtimeMs >= since
    } catch {
      return true
    }
  }
  const watcher: FSWatcher = watch(root, { recursive: true }, (event, file) => {
    if (file && !notProject(file) && edited(event, file)) void drop()
  })
  return {
    open: () => {
      if (!opened) {
        since = Date.now()
        opened = open({ root, ...o })
      }
      const current = opened
      current.catch(() => {
        if (opened === current) opened = null
      })
      return current
    },
    drop,
    close: () => {
      watcher.close()
      void drop()
    },
  }
}
