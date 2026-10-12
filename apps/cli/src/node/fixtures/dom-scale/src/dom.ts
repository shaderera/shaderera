import type { MountDom } from '@shaderera/core'

/** White, with a 1 CSS px black line at x = 10. */
const mount: MountDom = (element) => {
  element.style.cssText += ';background:#fff;position:relative'
  const line = document.createElement('div')
  line.style.cssText = 'position:absolute;left:10px;top:0;width:1px;height:100%;background:#000'
  element.append(line)
  return { seek: () => {} }
}
export default mount
