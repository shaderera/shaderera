import { animated, useSpring } from '@react-spring/web'
import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'

function App() {
  const s = useSpring({ from: { x: 0 }, to: { x: 400 }, config: { tension: 170, friction: 12 } })
  const o = useSpring({ from: { opacity: 0 }, to: { opacity: 1 }, config: { duration: 800 } })
  return [
    h(animated.div, {
      key: 'a',
      id: 'a',
      className: 'box',
      style: { transform: s.x.to((v) => `translateX(${v}px)`) },
    }),
    h(animated.div, { key: 'b', id: 'b', className: 'box', style: o }),
  ]
}
createRoot(document.getElementById('root')).render(h(App))
