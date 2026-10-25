// The running studio of a project, for the CLI's other commands to reach (docs/studio.md, "Stopping
// it"): `.shaderera/studio/bridge.json` holds its bridge's port and secret and its pid, readable by
// the user only. A request to that port without an Origin, carrying the secret, is the CLI's.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOST } from '../node/runner-server.ts'

export type Running = { port: number; secret: string; pid: number }

export const runningFile = (root: string): string =>
  join(root, '.shaderera', 'studio', 'bridge.json')

/** Whether a process with this pid is there (EPERM: there, another user's). */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const parse = (root: string): Running | null => {
  try {
    const r = JSON.parse(readFileSync(runningFile(root), 'utf8')) as Partial<Running>
    return typeof r.port === 'number' && typeof r.secret === 'string' && typeof r.pid === 'number'
      ? { port: r.port, secret: r.secret, pid: r.pid }
      : null
  } catch {
    return null
  }
}

/** The project's running studio; a file that is unreadable or names a dead pid is removed. */
export const readRunning = (root: string): Running | null => {
  const r = parse(root)
  if (r && alive(r.pid)) return r
  rmSync(runningFile(root), { force: true })
  return null
}

/**
 * On Windows, mode bits do nothing, and a project need not be under the user's profile: a folder
 * under `C:\` inherits read for `BUILTIN\Users`. The file's inherited entries are replaced with
 * one for the user's SID.
 */
const ownerOnly = (file: string) => {
  // Windows' own tools, by path: a whoami on PATH may be another (Git's).
  const bin = (exe: string) => join(process.env.SystemRoot ?? 'C:/Windows', 'System32', exe)
  const csv = execFileSync(bin('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const sid = /"(S-1-[\d-]+)"/.exec(csv)?.[1]
  if (!sid) throw new Error(`whoami gave no SID: ${csv.trim()}`)
  execFileSync(bin('icacls.exe'), [file, '/inheritance:r', '/grant:r', `*${sid}:F`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

/**
 * Writes the project's running studio, readable by the user only: the file is made private while
 * still empty, then filled, then moved into place (a move keeps its permissions).
 */
export const register = (root: string, r: Running): void => {
  const file = runningFile(root)
  mkdirSync(join(root, '.shaderera', 'studio'), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${r.pid}.tmp`
  writeFileSync(tmp, '', { mode: 0o600 })
  try {
    if (process.platform === 'win32') ownerOnly(tmp)
    writeFileSync(tmp, `${JSON.stringify(r)}\n`)
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/** Removes the file, if it still names this pid. */
export const unregister = (root: string, pid: number): void => {
  if (parse(root)?.pid === pid) rmSync(runningFile(root), { force: true })
}

/**
 * Asks the project's running studio to stop (`POST /stop`), and waits for its process to end.
 * `none`: no studio runs (a stale file is removed); `stopped`; `slow`: still ending after `waitMs`.
 */
export const stopRunning = async (
  root: string,
  waitMs = 30_000,
): Promise<{ state: 'none' | 'stopped' | 'slow'; pid?: number }> => {
  const r = readRunning(root)
  if (!r) return { state: 'none' }
  const answer = await fetch(`http://${HOST}:${r.port}/stop`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${r.secret}` },
    signal: AbortSignal.timeout(5000),
  }).catch(() => null)
  if (!answer) {
    // A pid taken by another process since, or a bridge that no longer answers: stale.
    rmSync(runningFile(root), { force: true })
    return { state: 'none' }
  }
  if (!answer.ok)
    throw new Error(
      `The studio (pid ${r.pid}) refused to stop: ${answer.status} ${await answer.text()}`,
    )
  for (const end = Date.now() + waitMs; Date.now() < end; ) {
    if (!alive(r.pid)) return { state: 'stopped', pid: r.pid }
    await new Promise((done) => setTimeout(done, 100))
  }
  return { state: 'slow', pid: r.pid }
}
