# @shaderera/core

The Shaderera protocol: anything that returns the same frame for the same `t` can be previewed,
inspected, debugged and rendered. Types plus a few host-independent helpers; no runtime
dependency on any renderer, framework or DOM API.

```ts
import type { Open } from '@shaderera/core'

const open: Open = async ({ manifest, io }) => {
  const canvas = io.canvas(manifest.width, manifest.height)
  return {
    async render(t) {
      // draw the frame for t with any technology
      return { color: canvas }
    },
    async inspect(t) {
      return { title: { id: 'title', opacity: Math.min(1, t) } }
    },
  }
}
export default open
```

Public API: the protocol types, `frameAt`, `frameTimes`, `flattenFrame`, `diffJson`,
`diffPixels`, `checkDeterminism`, `exportFrames`. `@shaderera/core/gpu` (GPU helpers such as
`readTexture`) is experimental; `@shaderera/core/host` is internal to the `shaderera` CLI.
The protocol and its reasons are in the repository's `docs/protocol.md`. MIT.
