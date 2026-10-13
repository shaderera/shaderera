three.js on the host's GPU, deterministic, in Node and the browser: render a scene at t and return it as a layer.

```ts
import * as THREE from 'three/webgpu'
import { createThreeHost, threeCamera } from './three/host.ts'

// in open
const three = await createThreeHost(host)                 // { toneMapping, exposure, samples, output }
const scene = new THREE.Scene()
const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicNodeMaterial())
scene.add(box)
const camera = threeCamera(W / H)                         // WebGPU clip space
camera.position.set(0, 0, 3)
camera.lookAt(0, 0, 0)

// in render(t, options)
box.rotation.y = t
return three.render(scene, camera, t, options)            // a layer; return an array to add more
```

camera-keyframes can drive the camera: `applyToThree(cameraTrack(keys)(t, W / H), camera, W / H)`.

Colours come out as written by default (no tone mapping): a paper `#F7F5F0` stays that colour
and artwork keeps its own. A lit 3D scene with bright lights wants `toneMapping:
THREE.ACESFilmicToneMapping` (or Neutral); ACES greys a white background.

It closes the traps of three in a frame-by-frame renderer: three's node clock runs from its own
requestAnimationFrame and adds the wall-clock time between renders (stopped here; set to t),
WebGPURenderer does not tone-map or sRGB-encode into a target (an output pass does), and MSAA with
blending is not deterministic on Dawn/D3D12 (`samples` 0 by default). The frame goes to the host as
a GPU texture with no copy; `output: 'bytes'` reads it back instead. Installs `three` 0.186.1.

Edges step without MSAA. `samples: 4` smooths them when nothing in the scene blends: opaque
materials only (no `transparent`, alpha-mapped cards or reflections). Run `shaderera check` after
turning it on: it renders the same t in two orders and fails if the pixels differ.
