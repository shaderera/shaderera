import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'

/**
 * A claim on a chunk of a plan: `<chunk file>.claim` in the plan folder, made before the chunk
 * renders and removed after, so two machines never render one chunk at once. It holds who made it;
 * its mtime is touched every HEARTBEAT_MS while the render runs.
 */
export type Claim = { host: string; pid: number; at: string; token: string }

/** How often a render touches its claim. */
export const HEARTBEAT_MS = 60_000
/** A claim not touched for this long is stale: its render died without removing it. */
export const STALE_MS = 10 * 60_000

/** Whether a process of this machine is running. */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it runs, as another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const claimPath = (dir: string, file: string) => join(dir, `${file}.claim`)

/**
 * The claim on `file` in `dir`, if any, and whether it still holds: made on this machine by a
 * process that is running, or elsewhere and touched within STALE_MS. An unreadable claim (cut
 * short as it was written) is held until it is stale.
 */
export const readClaim = (
  dir: string,
  file: string,
  now = Date.now(),
): (Partial<Claim> & { live: boolean; touched: number }) | undefined => {
  const path = claimPath(dir, file)
  let touched: number
  try {
    touched = statSync(path).mtimeMs
  } catch {
    return undefined
  }
  let claim: Partial<Claim> = {}
  try {
    claim = JSON.parse(readFileSync(path, 'utf8')) as Claim
  } catch {
    // Being written, or cut short: its age decides.
  }
  const fresh = now - touched < STALE_MS
  const live =
    claim.host === hostname() && typeof claim.pid === 'number' ? alive(claim.pid) && fresh : fresh
  return { ...claim, live, touched }
}

/** Who holds a claim, for a message. */
export const holder = (c: Partial<Claim>) =>
  `${c.host ?? 'an unknown host'} (pid ${c.pid ?? '?'}, since ${c.at ?? '?'})`

/**
 * Claims `file` in `dir` for this process: refused, naming the holder, while another live
 * process holds it; a stale claim is taken over. `ours()` says whether the claim is still this
 * process's; `release()` stops the heartbeat and removes the claim if it is.
 */
export const claim = (dir: string, file: string) => {
  const path = claimPath(dir, file)
  const mine: Claim = {
    host: hostname(),
    pid: process.pid,
    at: new Date().toISOString(),
    token: randomUUID(),
  }
  const text = `${JSON.stringify(mine)}\n`
  for (let attempt = 0; ; attempt++) {
    try {
      // `wx`: made only if no claim is there, so of two at once one wins.
      writeFileSync(path, text, { flag: 'wx' })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 2) throw error
      const held = readClaim(dir, file)
      if (held?.live)
        throw new Error(
          `${file} is being rendered by ${holder(held)}: wait for it, or render another chunk. A claim its render stops touching for ${STALE_MS / 60_000} minutes is taken over.`,
        )
      // Stale: its render died. Taken over.
      rmSync(path, { force: true })
    }
  }
  const ours = () => {
    try {
      return readFileSync(path, 'utf8') === text
    } catch {
      return false
    }
  }
  const beat = setInterval(() => {
    try {
      if (ours()) utimesSync(path, new Date(), new Date())
    } catch {
      // The next beat tries again.
    }
  }, HEARTBEAT_MS)
  beat.unref()
  return {
    ours,
    release: () => {
      clearInterval(beat)
      if (ours()) rmSync(path, { force: true })
    },
  }
}

/**
 * Removes what earlier renders of `out` left beside it (`<name>.<pid><suffix>`): those of
 * processes of this machine no longer running, or with `all` every one but this process's (a
 * chunk this process has claimed, which nobody else renders). One `keep` says to keep (a finished
 * film whose rename failed) stays.
 */
export const removePartials = (
  out: string,
  suffix: string,
  all = false,
  keep: (file: string) => boolean = () => false,
) => {
  const name = basename(out)
  let names: string[]
  try {
    names = readdirSync(dirname(out))
  } catch {
    return
  }
  for (const f of names) {
    if (!f.startsWith(`${name}.`) || !f.endsWith(suffix)) continue
    const pid = Number(f.slice(name.length + 1, f.length - suffix.length))
    if (!Number.isInteger(pid) || pid === process.pid) continue
    const file = join(dirname(out), f)
    if ((all || !alive(pid)) && !keep(file)) rmSync(file, { force: true })
  }
}
