Images as three.js textures, the same pixels in Node and the browser; an atlas for many cards.

```ts
import * as THREE from 'three/webgpu'
import { loadAtlas, loadTexture } from './three/textures.ts'

const art = await loadTexture(host, 'assets/painting.png')       // { texture, aspect }
const card = new THREE.Mesh(new THREE.PlaneGeometry(art.aspect, 1), new THREE.MeshBasicNodeMaterial({ map: art.texture }))

const field = await loadAtlas(host, paths, { cell: 512 })        // many images, one texture
// field.rects[i].rect = [u, v, w, h] for card i, field.rects[i].aspect its proportions
```

Images come from the host's `io.image`: PNG and JPEG decoded in JavaScript, never by a canvas or a
browser decoder, so every host samples the same pixels. `textureOf(img)` takes an image already
decoded. Textures are sRGB, 8 bits a channel (a 16-bit PNG keeps its high byte) and untouched:
artwork keeps its colours. WebP, AVIF, GIF and video frames: convert them to PNG once with the
`image-to-png` plugin. Installs `three`.
