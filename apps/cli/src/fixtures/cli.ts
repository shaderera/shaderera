import { format } from 'node:util'
import { run } from '../cli/main.ts'

/** What a CLI run gave: spawnSync's shape, so a test reads it as it would a child's. */
export type Ran = { status: number; stdout: string; stderr: string }

let queue: Promise<unknown> = Promise.resolve()

/**
 * `shaderera <args>` run in this process: the CLI's code, without a Node start and a type-strip of
 * the whole CLI per call. Its console and stderr are caught for the call. Calls run one at a time,
 * as the console is the process's own. One test spawns `bin/shaderera.js` for real (args.it.ts).
 */
export const cli = (...args: string[]): Promise<Ran> => {
  const ran = queue.then(async () => {
    const out: string[] = []
    const err: string[] = []
    const saved = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      write: process.stderr.write,
    }
    console.log = (...parts: unknown[]) => out.push(`${format(...parts)}\n`)
    console.error = (...parts: unknown[]) => err.push(`${format(...parts)}\n`)
    console.warn = console.error
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    try {
      const status = await run(args)
      return { status, stdout: out.join(''), stderr: err.join('') }
    } finally {
      Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn })
      process.stderr.write = saved.write
    }
  })
  queue = ran.catch(() => {})
  return ran
}
