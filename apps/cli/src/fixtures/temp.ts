import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

/**
 * A new empty folder `shaderera-<name>-XXXXXX` in the system temp folder, removed after the test
 * that made it, or after the file when made outside a test. The retries outlast the moment a
 * closed Chrome or ffmpeg still holds its files on Windows. Not in a before hook, where the folder
 * goes when the hook ends: make it at the file's top level, after the hook that closes what uses it.
 */
export const tempDir = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `shaderera-${name}-`))
  after(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
  return dir
}
