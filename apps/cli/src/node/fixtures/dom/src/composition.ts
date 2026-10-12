import type { Open } from '@shaderera/core'

/** Returns the host's DOM as the frame; with `mode: 'hang'` it never returns one. */
const open: Open = ({ params }) => ({
  render: async (_t, o) => {
    if (params.mode === 'hang') return new Promise(() => {})
    if (!o.dom) throw new Error('no DOM')
    return { color: o.dom, name: 'DOM' }
  },
})
export default open
