import { type ChildProcess, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { readRunning, stopRunning } from '../studio/running.ts'

const bin = fileURLToPath(new URL('../../bin/shaderera.js', import.meta.url))

/** `shaderera studio --json`'s `url` event, without its name. */
type Url = { url: string; id: string; [k: string]: unknown }

/**
 * MCP's `studio` tool: `shaderera studio --json` run as it is, one a project, for as long as the
 * server runs (its stdin is the server's pipe: closing it stops the studio) or until `stop`. A call
 * returns its latest `url` event; a studio started elsewhere is named, not replaced. `args` go to
 * every `shaderera studio` (the server's host flags; tests' --site and --no-open).
 */
export const studios = (args: readonly string[] = []) => {
  const mine = new Map<string, { child: ChildProcess; url?: Url; ended: Promise<void> }>()
  const start = (root: string): Promise<Url> => {
    const child = spawn(process.execPath, [bin, 'studio', '--json', '--root', root, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // Its stderr is the server's, and the end of it says why it ended early.
    let said = ''
    child.stderr?.on('data', (d: Buffer) => {
      process.stderr.write(d)
      said = (said + d.toString()).slice(-2000)
    })
    const s: { child: ChildProcess; url?: Url; ended: Promise<void> } = {
      child,
      ended: new Promise((done) => child.once('close', () => done())),
    }
    mine.set(root, s)
    void s.ended.then(() => {
      if (mine.get(root) === s) mine.delete(root)
    })
    return new Promise((done, fail) => {
      createInterface({ input: child.stdout as NodeJS.ReadableStream }).on('line', (line) => {
        let e: { event?: string; error?: string }
        try {
          e = JSON.parse(line)
        } catch {
          return
        }
        const { event, ...fields } = e
        // A new session's address (the page closed, an id expired) replaces the last.
        if (event === 'url') {
          s.url = fields as Url
          done(s.url)
        } else if (event === 'ended' && !s.url)
          fail(new Error(e.error ?? 'The studio ended before it gave an address.'))
      })
      void s.ended.then(() =>
        fail(new Error(said.trim() || `shaderera studio ended (${child.exitCode}).`)),
      )
    })
  }
  return {
    /** The project's studio, started or reused: its address, or the pid of one started elsewhere. */
    open: async (root: string) => {
      const s = mine.get(root)
      if (s?.url) return { ...s.url, reused: true }
      const other = readRunning(root)
      if (other)
        return {
          project: root,
          pid: other.pid,
          text: `A studio started elsewhere runs for ${root} (pid ${other.pid}): its page is the one it opened. stop: true stops it.`,
        }
      return start(root)
    },
    /** As `shaderera studio --stop`: the project's studio, whoever started it, ends cleanly. */
    stop: async (root: string) => {
      const r = await stopRunning(root)
      if (r.state === 'slow')
        throw new Error(
          `Asked the studio for ${root} (pid ${r.pid}) to stop; it is still starting or ending.`,
        )
      await mine.get(root)?.ended
      return r.state === 'none'
        ? { stopped: false, text: `No studio is running for ${root}.` }
        : { stopped: true, pid: r.pid, text: `Stopped the studio for ${root} (pid ${r.pid}).` }
    },
    /** The server ends: its studios end with it. */
    close: () => {
      for (const s of mine.values()) s.child.stdin?.end()
    },
  }
}
