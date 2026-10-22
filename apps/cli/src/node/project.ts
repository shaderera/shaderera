import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Manifest } from '@shaderera/core'
import { checkManifest } from '@shaderera/core/host'
import { shadereraVersion } from '../deliver/environment.ts'
import { assertRequirements } from '../registry/requires.ts'

export type Project = { readonly root: string; readonly manifest: Manifest }

/** The nearest directory at or above `cwd` with a shaderera.json, and its checked manifest. */
export const findProject = async (cwd: string): Promise<Project> => {
  let dir = resolve(cwd)
  while (!existsSync(join(dir, 'shaderera.json'))) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`No shaderera.json in ${resolve(cwd)} or above it.`)
    dir = parent
  }
  const text = await readFile(join(dir, 'shaderera.json'), 'utf8')
  const manifest = checkManifest(JSON.parse(text))
  // Decision 0008: a project whose shaderera.json requires what is not installed is refused
  // here, before anything renders, with the ways out (add, remove) in the message.
  assertRequirements(dir, shadereraVersion())
  return { root: dir, manifest }
}
