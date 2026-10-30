// How `shaderera render --stop` reaches the renders running in a project, as `studio --stop`
// reaches its studio (studio/running.ts): each render keeps `.shaderera/render/<pid>.json` with
// its pid, the port it listens on (127.0.0.1) and a stop token, readable by the user only. The
// token stops that render and does nothing else.
import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { alive } from '../node/build.ts'
import { HOST } from '../node/runner-server.ts'
import { privateDir } from '../studio/running.ts'

const folderOf = (root: string) => join(root, '.shaderera', 'render')

/**
 * Listens for `render --stop` while a render runs: `onStop` is called once a request carries the
 * token. Returns what ends it: the file goes, and the port closes.
 */
export const stoppable = async (root: string, onStop: () => void): Promise<() => void> => {
  const token = randomBytes(16).toString('hex')
  const server = createServer((req, res) => {
    const ok =
      req.method === 'POST' &&
      req.url === '/stop' &&
      req.headers.authorization === `Bearer ${token}`
    res.writeHead(ok ? 200 : 403).end()
    if (ok) onStop()
  })
  await new Promise<void>((done) => server.listen(0, HOST, done))
  const { port } = server.address() as AddressInfo
  const file = join(privateDir(folderOf(root)), `${process.pid}.json`)
  writeFileSync(file, `${JSON.stringify({ pid: process.pid, port, token })}\n`, { mode: 0o600 })
  return () => {
    rmSync(file, { force: true })
    server.close()
  }
}

/**
 * Stops every render running in the project and waits for each to end (at most `waitMs`). A file
 * of a process that has ended, or that no longer answers, is removed. Returns the pids stopped and
 * the ones still ending.
 */
export const stopRenders = async (
  root: string,
  waitMs = 60_000,
): Promise<{ stopped: number[]; slow: number[] }> => {
  const dir = folderOf(root)
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n))
  } catch {
    return { stopped: [], slow: [] }
  }
  const asked: number[] = []
  for (const name of names) {
    const file = join(dir, name)
    let r: { pid?: unknown; port?: unknown; token?: unknown }
    try {
      r = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (typeof r.pid !== 'number' || !alive(r.pid)) {
      rmSync(file, { force: true })
      continue
    }
    const answer = await fetch(`http://${HOST}:${r.port}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${r.token}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => null)
    if (answer?.ok) asked.push(r.pid)
    // A pid taken by another process since, or a render that no longer answers: stale.
    else if (!answer) rmSync(file, { force: true })
  }
  const until = Date.now() + waitMs
  while (asked.some(alive) && Date.now() < until) await new Promise((done) => setTimeout(done, 100))
  return { stopped: asked.filter((p) => !alive(p)), slow: asked.filter(alive) }
}
