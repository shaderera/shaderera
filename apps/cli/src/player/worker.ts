// The web player's worker: the engine's runner worker (runner/worker.ts), configured for a static
// player. io.read finds the film's files in files/ beside assets/, and io.video, io.cache and
// io.bake are answered here (services.ts), not by a CLI process.
import { configureRunner } from '../runner/worker.ts'
import { playerAsk } from './services.ts'

/** The viewer's own files for clip params, by their `local:` names, as the bridge hands them over. */
const local = new Map<string, Blob>()
self.addEventListener('message', (e: MessageEvent) => {
  const f = (e.data as { shadereraFile?: { name?: unknown; file?: unknown } } | null)?.shadereraFile
  if (f && typeof f.name === 'string' && f.name.startsWith('local:') && f.file instanceof Blob)
    local.set(f.name, f.file)
})

// Through a variable: `new URL('…', import.meta.url)` written out is an asset to Vite.
const here = import.meta.url
const files = new URL('../files/', here).href
configureRunner({ files, ask: playerAsk(files, (name) => local.get(name)) })
