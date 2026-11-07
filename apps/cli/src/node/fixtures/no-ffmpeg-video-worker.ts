// A clip's decoder thread with no ffmpeg on its PATH: the real one (video-worker.ts), whose decoder
// cannot start. What services.test.ts asks frames of; the CLI's thread keeps its own PATH.
import { fileURLToPath } from 'node:url'

for (const key of Object.keys(process.env))
  if (key.toUpperCase() === 'PATH') delete process.env[key]
process.env.PATH = fileURLToPath(new URL('.', import.meta.url))
await import('../video-worker.ts')
