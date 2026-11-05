import type { MountDom } from '@shaderera/core'
import { at, CARD, DOT } from './move.ts'

/** Two boxes with a data-id, moved by a transform at each t. */
const mount: MountDom = (element) => {
  element.style.cssText += ';background:#000;position:relative'
  element.innerHTML =
    '<div data-id="card" style="position:absolute;left:0;top:4px;width:10px;height:10px;background:#fc0"></div>' +
    '<div data-id="dot" style="position:absolute;left:0;top:20px;width:4px;height:4px;background:#0cf"></div>'
  const card = element.querySelector('[data-id=card]') as HTMLElement
  const dot = element.querySelector('[data-id=dot]') as HTMLElement
  return {
    seek: (t) => {
      card.style.transform = `translateX(${at(t, CARD)}px)`
      dot.style.transform = `translateX(${at(t, DOT)}px)`
    },
  }
}
export default mount
