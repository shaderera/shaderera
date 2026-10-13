// render-three-host: the README's scene, rendered by the plugin on the host's GPU: a box with a
// basic node material, turned by t, through a camera in WebGPU clip space. A grey box with white
// edges on a thin grid, so the turn and the camera read; the camera circles it once a loop. Nothing
// else is in the scene. The box turns a quarter a loop, so frame 0 follows the last frame.

import * as THREE from 'three/webgpu'
import { createHouse, type Word } from '../../previews/src/house.ts'
import type { OpenPreview } from '../../previews/src/preview.ts'
import { createThreeHost, threeCamera } from '../../previews/src/three/host.ts'

const TAU = Math.PI * 2

const renderThreeHost: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`render-three-host has no state "${stateId}"`)
  const { width: W, height: H, duration } = host.manifest
  // Every material is opaque, so multisampling stays deterministic (see the plugin's README).
  const three = await createThreeHost(host, { samples: 4 })
  const canvas = host.io.canvas(W, H)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const theme = createHouse(host, ctx)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)
  const geometry = new THREE.BoxGeometry()
  const box = new THREE.Mesh(geometry, new THREE.MeshBasicNodeMaterial({ color: 0x3a3a3a }))
  box.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicNodeMaterial({ color: 0xffffff }),
    ),
  )
  box.position.y = 0.5
  scene.add(box)
  const grid = new THREE.GridHelper(12, 24, 0x6a6a6a, 0x2e2e2e)
  scene.add(grid)

  const camera = threeCamera(W / H)
  // The subject sits in the middle of the picture above the caption.
  camera.setViewOffset(1000, 1000, 0, 82, 1000, 1000)
  const top: Word[] = [{ from: 0, to: duration, text: 'BOX.ROTATION.Y' }]
  const bottom: Word[] = [{ from: 0, to: duration, text: 'THREE.JS' }]
  const turn = (t: number) => ((t / duration) * TAU) / 4

  return {
    async render(t, o) {
      box.rotation.y = turn(t)
      const a = (t / duration) * TAU
      camera.position.set(4.6 * Math.sin(a), 2.3 + 0.5 * Math.sin(2 * a), 4.6 * Math.cos(a))
      camera.lookAt(0, 0.5, 0)
      camera.updateProjectionMatrix()
      const layer = await three.render(scene, camera, t, o)
      ctx.clearRect(0, 0, W, H)
      theme.wash(W)
      theme.index()
      theme.words(top, bottom, t, o.frame)
      theme.note('the scene rendered at t, the node clock set to t', 1032, 800)
      theme.hud(
        t,
        o.frame,
        `NODE CLOCK ${t.toFixed(3)} S = T`,
        `ROTATION.Y ${turn(t).toFixed(3)}   WEBGPU`,
      )
      return [layer, { color: canvas, name: 'overlay' }]
    },
    status(t) {
      return `t ${t.toFixed(2)} s`
    },
    inspect(t) {
      return { id: 'three', clock: t, rotationY: turn(t) }
    },
  }
}

export default renderThreeHost
