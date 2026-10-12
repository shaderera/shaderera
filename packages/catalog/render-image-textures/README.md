Images as three.js textures, the same pixels in Node and the browser; an atlas for many cards; WebP and video frames converted to PNG once.

```sh
node tools/to-png.ts assets/*.webp                 # once: WebP → PNG beside each (colours kept)
node tools/to-png.ts --frames 12 assets/clip.webm  # a clip's frames as PNGs
```

```ts
import { loadAtlas, loadTexture } from './three/images.ts'

const art = await loadTexture(host, 'assets/painting.png')       // { texture, aspect }
const card = new THREE.Mesh(new THREE.PlaneGeometry(art.aspect, 1), new THREE.MeshBasicNodeMaterial({ map: art.texture }))

const field = await loadAtlas(host, paths, { cell: 512 })        // many images, one texture
// field.rects[i].rect = [u, v, w, h] for card i, field.rects[i].aspect its proportions
```

PNG and JPEG are decoded in JavaScript (fast-png, jpeg-js), never by a canvas or a browser
decoder, so every host samples the same pixels. Textures are sRGB and untouched: artwork keeps its
colours. Installs `three`, `fast-png` and `jpeg-js`.
