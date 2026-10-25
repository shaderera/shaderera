#!/usr/bin/env node
// Starts the plugin's MCP server, `npx -y shaderera mcp`, after clearing a lock a killed npx left.
//
// npx (npm 11) holds `concurrency.lock` in its install folder while it reads or installs the
// package, touches it every second, and treats it as stale only after 60 s. Claude Code ends a
// session's servers with `taskkill /T /F`, which skips npx's cleanup, so a session closed while
// its server is starting can leave the lock behind, and every npx start after it waits about
// 60 s: past Claude Code's 30 s connect timeout (#383).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rmdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where npx keeps its lock for `npx shaderera`: the folder is named by the first 16 hex of the
 * sha512 of the package list. A cache set only in an .npmrc is not seen, and then nothing is
 * cleared.
 */
export function npxLock(env = process.env, platform = process.platform) {
  const cache =
    env.npm_config_cache ??
    env.NPM_CONFIG_CACHE ??
    (platform === 'win32'
      ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'npm-cache')
      : join(homedir(), '.npm'))
  const folder = createHash('sha512').update('shaderera').digest('hex').slice(0, 16)
  return join(cache, '_npx', folder, 'concurrency.lock')
}

/**
 * Waits until the lock is gone, removing it once nothing has touched it for `staleMs` (a live
 * npx touches it every second). Returns 'none', 'released' or 'removed'.
 */
export async function clearStaleLock(lock, staleMs = 5_000) {
  let seen = false
  for (;;) {
    let mtime
    try {
      mtime = statSync(lock).mtimeMs
    } catch {
      return seen ? 'released' : 'none'
    }
    seen = true
    if (Date.now() - mtime > staleMs) {
      try {
        rmdirSync(lock)
        return 'removed'
      } catch {
        // Another start removed or retook it: look again.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

if (import.meta.main) {
  await clearStaleLock(npxLock())
  const child = spawn('npx', ['-y', 'shaderera', 'mcp', ...process.argv.slice(2)], {
    stdio: 'inherit',
    // npx is npx.cmd on Windows, which only a shell runs.
    shell: process.platform === 'win32',
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('error', (err) => {
    console.error(`shaderera mcp: could not start npx: ${err.message}`)
    process.exit(1)
  })
  child.on('exit', (code) => process.exit(code ?? 1))
}
