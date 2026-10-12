# DOM (HTML, CSS, React)

A project's DOM is a module named by `shaderera.json` `dom`, run by the browser host
(`"host": "browser"`). The host lays it out on its page at the frame's size, sets it to each t,
waits until it is ready, draws it with HTML-in-Canvas and hands the result to `render` as
`options.dom` (an `ImageBitmap`, straight alpha). The source returns it as a layer or uses it as
a texture. There is no capture by screenshot and no second browser.

## The module

```tsx
import type { MountDom } from '@shaderera/core'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Card } from './Card.tsx'

const mount: MountDom = async (element, { manifest, params }) => {
  // Load web fonts here: what t shows must be loaded before it is drawn.
  const root = createRoot(element)
  const show = (t: number) => flushSync(() => root.render(<Card t={t} />))
  show(0)
  return { seek: show, dispose: () => root.unmount() }
}
export default mount
```

- `seek(t)` sets the DOM to t. It may return a promise (a video seeking, a player).
- The DOM must be a function of t. CSS animations and transitions are held at t by the host;
  timers and `requestAnimationFrame` loops are not, and a DOM still changing after 7 snapshots
  fails the capture.
- A font face that failed, an image that did not load, or a video with no frame at t fails the
  capture with its name. It is never drawn blank and accepted.

## Sharpness: `domScale`

`options.dom` is drawn at the frame's size: one pixel per CSS pixel. A source that shows the DOM
larger than that (a texture seen up close) sets `"domScale"` (1–4): the layout stays the same, the
DOM is re-rasterised with that many pixels per CSS pixel. As a layer it is scaled to the frame.

## What the host measures

The browser host measures the DOM's text itself (content, font, size, effective opacity, box in
frame pixels, and the fonts Chrome drew it with), so review's copy, fit, overlap, glyph and
reading checks work without the source reporting anything. Give elements `data-id` to name them.

## Limits

Browser host only: HTML-in-Canvas is a Chrome feature behind a flag (`CanvasDrawElement`); the
Node host has no DOM, and a project with
`dom` cannot be run with `--host node`.
