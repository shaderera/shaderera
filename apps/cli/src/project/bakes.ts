// Bakes (decision 0016): frames a film reads that were made outside the host. Shaderera never
// knows what a bake's command does, only that its frames derive from its inputs: `shaderera bake`
// runs the command and stamps the inputs and the frames it made, and a render refuses a bake whose
// inputs or frames no longer match its stamp. Never a silent fallback (decision 0008).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Bake, Manifest } from '@shaderera/core'
import { inside } from '../node/inside.ts'
import type { BakeFrames } from '../node/services.ts'
import { slash } from './revisions.ts'

/** What `shaderera bake` made: the stamp a render checks the bake against. */
export type BakeStamp = {
  shaderera: 'bake/1'
  name: string
  /** The declaration it was made from: a changed one is another bake. */
  bake: Bake
  /** The hash of the inputs' paths and contents, and each input file's own hash. */
  inputs: { hash: string; files: { [path: string]: string } }
  /** The folder the frames are in, absolute. */
  dir: string
  /** The frames in order: file name, bytes and sha256. */
  frames: { file: string; bytes: number; sha256: string }[]
  made: string
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')

/** Where a bake's stamp is kept: beside revisions and jobs, outside any revision. */
export const stampFile = (root: string, name: string) =>
  join(root, 'versions', 'bakes', `${name}.json`)

/** A declared bake, or an error naming the ones declared. */
export const bakeOf = (manifest: Manifest, name: string): Bake => {
  const bake = manifest.bakes?.[name]
  if (!bake) {
    const names = Object.keys(manifest.bakes ?? {})
    throw new Error(
      `shaderera.json declares no bake "${name}"${names.length ? ` (it declares ${names.join(', ')})` : ''}.`,
    )
  }
  return bake
}

/** The folder a bake writes: relative to the project, or absolute (another drive). */
export const bakeDir = (root: string, bake: Bake) =>
  isAbsolute(bake.dir) ? resolve(bake.dir) : resolve(root, bake.dir)

/**
 * The inputs' files, each with its hash, and one hash over their paths and contents. A folder is
 * every file under it. Inputs are project paths; one that is missing or outside is refused.
 */
export const hashInputs = (root: string, inputs: readonly string[]) => {
  const files: { [path: string]: string } = {}
  const add = (file: string) => {
    files[slash(file.slice(resolve(root).length + 1))] = sha256(readFileSync(file))
  }
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) add(file)
    }
  }
  for (const input of inputs) {
    const file = inside(root, input)
    if (!existsSync(file)) throw new Error(`A bake input is missing: ${input}.`)
    if (statSync(file).isDirectory()) walk(file)
    else add(file)
  }
  return hashOf(files)
}

/** One hash over files' paths and hashes, and the files in order. */
const hashOf = (files: { readonly [path: string]: string }) => {
  const sorted = Object.keys(files).sort()
  const hash = sha256(sorted.map((p) => `${p}\0${files[p]}`).join('\n'))
  return { hash, files: Object.fromEntries(sorted.map((p) => [p, files[p] as string])) }
}

/**
 * The frames in a bake's folder, in order: the files its `frames` names with 0, 1, 2… A number
 * missing between them, or a file numbered past the end with a gap, is refused.
 */
export const listFrames = (dir: string, frames: string): string[] => {
  const run = /#+/.exec(frames) as RegExpExecArray
  const before = frames.slice(0, run.index)
  const after = frames.slice(run.index + run[0].length)
  const digits = run[0].length
  const named = new Map<number, string>()
  for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    if (!file.startsWith(before) || !file.endsWith(after)) continue
    const number = file.slice(before.length, file.length - after.length)
    if (new RegExp(`^\\d{${digits},}$`).test(number)) named.set(Number(number), file)
  }
  const list = [...named.keys()].sort((a, b) => a - b)
  const missing = list.findIndex((n, i) => n !== i)
  if (missing >= 0)
    throw new Error(
      `${frames} in ${dir}: frame ${missing} is missing, though later ones are there.`,
    )
  return list.map((n) => named.get(n) as string)
}

const readStamp = (root: string, name: string): BakeStamp | undefined => {
  const file = stampFile(root, name)
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as BakeStamp) : undefined
}

/**
 * Runs a bake's command in the project folder with the person's rights (the same trust as an npm
 * script: render never runs it), then stamps what it made. The inputs are hashed before and after:
 * a change while it ran is refused, since the frames may come from either.
 */
export const makeBake = (root: string, manifest: Manifest, name: string): BakeStamp => {
  const bake = bakeOf(manifest, name)
  const inputs = hashInputs(root, bake.inputs)
  const dir = bakeDir(root, bake)
  mkdirSync(dir, { recursive: true })
  const r = spawnSync(bake.command, { cwd: root, shell: true, stdio: ['ignore', 2, 2] })
  if (r.error) throw new Error(`bake ${name}: ${bake.command} could not start: ${r.error.message}`)
  if (r.status !== 0)
    throw new Error(`bake ${name}: ${bake.command} exited with ${r.status}; nothing was stamped.`)
  if (hashInputs(root, bake.inputs).hash !== inputs.hash)
    throw new Error(`bake ${name}: its inputs changed while it ran; bake again.`)
  const files = listFrames(dir, bake.frames)
  if (files.length === 0)
    throw new Error(`bake ${name}: ${bake.command} wrote no ${bake.frames} in ${dir}.`)
  const stamp: BakeStamp = {
    shaderera: 'bake/1',
    name,
    bake,
    inputs,
    dir,
    frames: files.map((file) => {
      const bytes = readFileSync(join(dir, file))
      return { file, bytes: bytes.length, sha256: sha256(bytes) }
    }),
    made: new Date().toISOString(),
  }
  const out = stampFile(root, name)
  mkdirSync(join(out, '..'), { recursive: true })
  writeFileSync(`${out}.${process.pid}.tmp`, `${JSON.stringify(stamp, null, 1)}\n`)
  renameSync(`${out}.${process.pid}.tmp`, out)
  return stamp
}

/**
 * Checks every bake the manifest declares against its stamp and returns its frames, or throws
 * naming the bake and the command that makes it again: not made yet, made from another
 * declaration, inputs changed, or a frame missing or changed since.
 */
export const checkBakes = (root: string, manifest: Manifest): BakeFrames => {
  const out: { [name: string]: string[] } = {}
  for (const [name, bake] of Object.entries(manifest.bakes ?? {})) {
    const again = `shaderera bake ${name}`
    const stamp = readStamp(root, name)
    if (!stamp) throw new Error(`Bake ${name} has not been made: ${again}.`)
    out[name] = checkStamp(root, stamp, bake, again)
  }
  return out
}

/** A stamp against the declaration, the inputs and the frames as they are now. */
export const checkStamp = (root: string, stamp: BakeStamp, bake: Bake, again: string): string[] => {
  const name = stamp.name
  if (JSON.stringify(stamp.bake) !== JSON.stringify(bake))
    throw new Error(`Bake ${name} is declared differently from when it was made: ${again}.`)
  const now = hashInputs(root, bake.inputs)
  if (now.hash !== stamp.inputs.hash) {
    const changed = Object.keys({ ...now.files, ...stamp.inputs.files })
      .filter((p) => now.files[p] !== stamp.inputs.files[p])
      .sort()
    throw new Error(
      `Bake ${name} is stale: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` and ${changed.length - 5} more` : ''} changed since it was made. Run ${again}.`,
    )
  }
  return checkFrames(`Bake ${name}`, stamp, `Run ${again}.`)
}

/** The frames as stamped, each still there with its hash; or throws `what: <frame> …. <fix>`. */
const checkFrames = (what: string, s: Pick<BakeStamp, 'dir' | 'frames'>, fix: string) =>
  s.frames.map((f) => {
    const file = join(s.dir, f.file)
    if (!existsSync(file)) throw new Error(`${what}: ${f.file} is missing from ${s.dir}. ${fix}`)
    if (sha256(readFileSync(file)) !== f.sha256)
      throw new Error(`${what}: ${f.file} changed since it was made. ${fix}`)
    return file
  })

/** What a job pins of each bake its source reads: the stamp's inputs, folder and frames. */
export type JobBakes = {
  [name: string]: { inputs: string; dir: string; frames: BakeStamp['frames'] }
}

/**
 * The bakes a revision's manifest declares, pinned for a job: each stamp must have been made from
 * the inputs as that revision has them (`files`, path → sha256), and its frames must be there.
 */
export const pinBakes = (
  root: string,
  manifest: Manifest,
  revision: string,
  files: { readonly [path: string]: string },
): JobBakes => {
  const pinned: JobBakes = {}
  for (const [name, bake] of Object.entries(manifest.bakes ?? {})) {
    const again = `shaderera bake ${name}`
    const stamp = readStamp(root, name)
    if (!stamp) throw new Error(`Bake ${name} has not been made: ${again}.`)
    if (JSON.stringify(stamp.bake) !== JSON.stringify(bake))
      throw new Error(
        `Bake ${name} was made from another declaration than revision ${revision}'s: ${again}.`,
      )
    const inputs = bake.inputs.map((i) => slash(i).replace(/^\.\//, '').replace(/\/$/, ''))
    const under = (path: string) => inputs.some((i) => path === i || path.startsWith(`${i}/`))
    const at = hashOf(Object.fromEntries(Object.entries(files).filter(([p]) => under(p))))
    if (at.hash !== stamp.inputs.hash)
      throw new Error(
        `Bake ${name} was made from other inputs than revision ${revision} has: bake it from that revision (shaderera restore ${revision}, then ${again}), or make the job from the revision it was made from.`,
      )
    checkFrames(`Bake ${name}`, stamp, `Run ${again}.`)
    pinned[name] = { inputs: stamp.inputs.hash, dir: stamp.dir, frames: stamp.frames }
  }
  return pinned
}

/**
 * A job's bakes as it pinned them, each frame still there with its hash: the frames its host
 * reads. Throws naming the bake and the way back.
 */
export const checkJobBakes = (job: {
  name: string
  revision: string
  inputs: { bakes?: JobBakes }
}): BakeFrames =>
  Object.fromEntries(
    Object.entries(job.inputs.bakes ?? {}).map(([name, pin]) => [
      name,
      checkFrames(
        `Bake ${name} no longer matches job ${job.name}`,
        pin,
        `Bake it again from the job's revision (shaderera restore ${job.revision}, then shaderera bake ${name}), or make a new job.`,
      ),
    ]),
  )
