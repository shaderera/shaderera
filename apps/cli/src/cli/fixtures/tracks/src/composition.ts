import type { Open } from '@shaderera/core'
import { at, CARD, DOT } from './move.ts'

/** The DOM is the frame; inspect reports where each element is, as the DOM draws it. */
const open: Open = () => ({
  render: async (_t, o) => {
    if (!o.dom) throw new Error('no DOM')
    return { color: o.dom, name: 'DOM' }
  },
  inspect: async (t) => ({
    objects: [
      { id: 'card', x: at(t, CARD) },
      { id: 'dot', x: at(t, DOT) },
    ],
  }),
})
export default open
