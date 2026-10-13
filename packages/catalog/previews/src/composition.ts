// One preview per catalog item, chosen by the variant (params.item and params.state): the item's
// own picture in src/<item>.ts, under the caption every preview shares.

import type { Open } from '@shaderera/core'
import audioBeatClock from './audio-beat-clock.ts'
import { createCaption } from './caption.ts'
import { ITEMS } from './items.ts'
import lookScreenPasses from './look-screen-passes.ts'
import { FONT_FILES, type OpenPreview } from './preview.ts'
import textKinetic from './text-kinetic.ts'

const PREVIEWS: Record<string, OpenPreview> = {
  'look-screen-passes': lookScreenPasses,
  'text-kinetic': textKinetic,
  'audio-beat-clock': audioBeatClock,
}

const open: Open = async (host) => {
  for (const [path, family] of FONT_FILES) await host.io.font(path, family)
  const item = String(host.params.item ?? 'look-screen-passes')
  const entry = ITEMS[item]
  const openPreview = PREVIEWS[item]
  if (!entry || !openPreview)
    throw new Error(`No preview for "${item}": add src/${item}.ts, and list it in src/items.ts`)
  const state = String(host.params.state ?? entry.default)
  if (!entry.states.some((s) => s.id === state))
    throw new Error(`${item} has no state "${state}" (src/items.ts)`)
  const preview = await openPreview(host, state)
  const caption = createCaption(host, item, entry.caption)
  const status = (t: number) => preview.status?.(t) ?? ''
  return {
    async render(t, o) {
      const layers = await preview.render(t, o)
      return [...layers, { color: caption.draw(status(t)), name: 'caption' }]
    },
    async inspect(t) {
      return {
        item,
        state,
        preview: preview.inspect?.(t) ?? null,
        caption: caption.runs(status(t)),
      }
    },
    ...(preview.audio ? { audio: () => preview.audio?.() ?? Promise.resolve([]) } : {}),
  }
}

export default open
