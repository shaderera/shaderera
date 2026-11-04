// Captures the analysis-web-capture preview's page with the item's own tool, as a person would:
// preview/page.html at 30 fps for 4 s in a 1280x720 viewport, into
// references/web-capture/tracks.json of the previews project. Needs Chrome (CHROME, else the
// install paths). Run after scripts/assemble.ts (scripts/render.ts does both).
//   node packages/plugins/analysis-web-capture/preview/make.ts

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..', 'previews')
execFileSync(
  process.execPath,
  [
    join(root, 'tools', 'capture-web.ts'),
    join(import.meta.dirname, 'page.html'),
    ...['--out', 'references/web-capture'],
    ...['--track', '#bar', '--track', '#card', '--track', '#dot'],
    ...['--fps', '30', '--duration', '4', '--viewport', '1280x720'],
  ],
  { cwd: root, stdio: 'inherit' },
)
