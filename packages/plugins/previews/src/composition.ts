// One preview per plugin, chosen by the variant (params.item and params.state): the plugin's own
// picture in packages/plugins/<item>/preview/index.ts, with its caption and states from
// preview.json beside it, under the caption every preview shares. Nothing here lists the plugins:
// scripts/render.ts finds them and writes their variants into shaderera.json.

import type { Open } from '@shaderera/core'
import { createCaption } from './caption.ts'
import { FONT_FILES, type OpenPreview, type PreviewConfig } from './preview.ts'

const open: Open = async (host) => {
  for (const [path, family] of FONT_FILES) await host.io.font(path, family)
  const item = String(host.params.item ?? '')
  let config: PreviewConfig
  let openPreview: OpenPreview
  try {
    config = (await import(`../../${item}/preview/preview.json`)).default
    openPreview = (await import(`../../${item}/preview/index.ts`)).default
  } catch (e) {
    throw new Error(
      `No preview for "${item}": add packages/plugins/${item}/preview/ (preview.json and index.ts), then run scripts/render.ts`,
      { cause: e },
    )
  }
  const state = String(host.params.state ?? config.default)
  if (!config.states.some((s) => s.id === state))
    throw new Error(`${item} has no state "${state}" (its preview/preview.json)`)
  const preview = await openPreview(host, state)
  const caption = createCaption(host, item, config.caption)
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
