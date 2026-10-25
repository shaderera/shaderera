// The running studio of a project, for the CLI's other commands to reach (docs/studio.md, "One
// studio a project"): `.shaderera/studio/bridge.json` holds its pid, and, once its bridge is up,
// the bridge's port and secret, readable by the user only. A request to that port without an
// Origin, carrying the secret, is the CLI's.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { HOST } from '../node/runner-server.ts'

/** A studio that claimed the project and is starting, or one whose bridge is up. */
export type Running =
  | { state: 'starting'; pid: number }
  | { state: 'running'; pid: number; port: number; secret: string }

/** Another studio holds the project: the command refuses to start. */
export class StudioRunning extends Error {}

const folderOf = (root: string): string => join(root, '.shaderera', 'studio')
export const runningFile = (root: string): string => join(folderOf(root), 'bridge.json')

/** Whether a process with this pid is there (EPERM: there, another user's). */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Windows' own tools, by path: a whoami on PATH may be another (Git's). */
const system32 = (exe: string) => join(process.env.SystemRoot ?? 'C:/Windows', 'System32', exe)

/**
 * Makes the folder private before any file is made in it: on Windows its inherited entries are
 * replaced with one for the user's SID, inherited by every file made in it (mode bits do nothing
 * there, and a project outside the profile inherits read for `BUILTIN\Users` from `C:\`); on
 * macOS and Linux it is mode 0700.
 */
export const privateFolder = (root: string): string => {
  const dir = folderOf(root)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') {
    chmodSync(dir, 0o700)
    return dir
  }
  const csv = execFileSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const sid = /"(S-1-[\d-]+)"/.exec(csv)?.[1]
  if (!sid) throw new Error(`whoami gave no SID: ${csv.trim()}`)
  execFileSync(system32('icacls.exe'), [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  return dir
}

/** The file as it is: null when there is none or it is not one of ours; unreadable throws. */
const parse = (root: string): Running | null => {
  let text: string
  try {
    text = readFileSync(runningFile(root), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(
      `Cannot read ${runningFile(root)} (${(error as NodeJS.ErrnoException).code}): it may be another user's studio. Remove it if no studio runs.`,
    )
  }
  try {
    const r = JSON.parse(text) as Partial<{ pid: number; port: number; secret: string }>
    if (typeof r.pid !== 'number') return null
    return typeof r.port === 'number' && typeof r.secret === 'string'
      ? { state: 'running', pid: r.pid, port: r.port, secret: r.secret }
      : { state: 'starting', pid: r.pid }
  } catch {
    return null
  }
}

const remove = (root: string) => {
  try {
    rmSync(runningFile(root), { force: true })
  } catch (error) {
    throw new Error(
      `Cannot remove the stale ${runningFile(root)} (${(error as NodeJS.ErrnoException).code}). Remove it yourself.`,
    )
  }
}

/** The project's studio, starting or running; a file that names a dead pid is removed. */
export const readRunning = (root: string): Running | null => {
  const r = parse(root)
  if (r && alive(r.pid)) return r
  remove(root)
  return null
}

/**
 * A file of this pid's own, made exclusively (never one planted before) in the private folder and
 * written whole: a reader of `bridge.json` never sees half of one.
 */
const whole = (root: string, value: object, pid: number): string => {
  const tmp = `${runningFile(root)}.${pid}.tmp`
  rmSync(tmp, { force: true })
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 })
  return tmp
}

/**
 * Claims the project for this studio before its bridge starts: `bridge.json` is made exclusively,
 * holding the pid only, so two studios started at once never both run. Another live studio's
 * claim throws StudioRunning; a stale one is removed and the claim made again.
 */
export const claim = (root: string, pid: number): void => {
  privateFolder(root)
  for (let tries = 0; ; tries++) {
    const tmp = whole(root, { pid }, pid)
    try {
      // A link fails if bridge.json is there: it is made whole, and only if no one else has.
      linkSync(tmp, runningFile(root))
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 0) throw error
    } finally {
      rmSync(tmp, { force: true })
    }
    const other = readRunning(root)
    if (other)
      throw new StudioRunning(
        `A studio is ${other.state === 'starting' ? 'starting' : 'already running'} for ${root} (pid ${other.pid}). Stop it with shaderera studio --stop first.`,
      )
  }
}

/** The bridge is up: its port and secret go in the claimed file. */
export const register = (root: string, r: { pid: number; port: number; secret: string }): void =>
  renameSync(whole(root, r, r.pid), runningFile(root))

/** Removes the file, if it still names this pid. */
export const unregister = (root: string, pid: number): void => {
  try {
    if (parse(root)?.pid === pid) rmSync(runningFile(root), { force: true })
  } catch {}
}

/**
 * Asks the project's studio to stop (`POST /stop`), and waits for its process to end. A studio
 * still starting is waited for until its bridge is up. `none`: no studio runs (a stale file is
 * removed); `stopped`; `slow`: still starting or ending after `waitMs`.
 */
export const stopRunning = async (
  root: string,
  waitMs = 60_000,
): Promise<{ state: 'none' | 'stopped' | 'slow'; pid?: number }> => {
  const until = Date.now() + waitMs
  let r = readRunning(root)
  while (r?.state === 'starting' && Date.now() < until) {
    await new Promise((done) => setTimeout(done, 200))
    r = readRunning(root)
  }
  if (!r) return { state: 'none' }
  if (r.state === 'starting') return { state: 'slow', pid: r.pid }
  const answer = await fetch(`http://${HOST}:${r.port}/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${r.secret}` },
    signal: AbortSignal.timeout(5000),
  }).catch(() => null)
  if (!answer) {
    // A pid taken by another process since, or a bridge that no longer answers: stale.
    remove(root)
    return { state: 'none' }
  }
  if (!answer.ok)
    throw new Error(
      `The studio (pid ${r.pid}) refused to stop: ${answer.status} ${await answer.text()}`,
    )
  while (Date.now() < until) {
    if (!alive(r.pid)) return { state: 'stopped', pid: r.pid }
    await new Promise((done) => setTimeout(done, 100))
  }
  return { state: 'slow', pid: r.pid }
}
