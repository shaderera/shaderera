import type { MountDom } from '@shaderera/core'

/** An animated DOM: a bar 3 px wider every frame. */
const mount: MountDom = (element) => {
  const bar = document.createElement('div')
  bar.style.cssText = 'height:8px;background:#000'
  element.append(bar)
  return {
    seek: (t) => {
      bar.style.width = `${Math.round(t * 30)}px`
    },
  }
}
export default mount
