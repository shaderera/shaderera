# hybrid fixture

An engineering fixture for the CLI's tests. 1920×1080, 30 fps, 6 s. The frame is a flat stack of two layers, bottom to top:

1. **World** (three.js `WebGPURenderer` on `host.gpu`, read back as bytes): a cube, a floor and a world-space sign, all depth-tested in one pass. The sign's text is drawn with `io.canvas`, read with `getImageData` and uploaded as a `DataTexture` on a plane, so it works in the browser Worker and in Node. Its camera keys are the same as in `3d-product`.
2. **Screen** (Canvas2D, transparent): an opaque lower-third `plate` and a `title` that slides in over the first 0.8 s. This layer never reads the camera.

**Exercises:**
- `inspect(t)` returns `world` objects (`space: 'world'`), `screen` objects (`space: 'screen'`, each with a `box`) and `camera` with its bracketing `keys`.
- `pick(t, x, y)` checks the screen boxes first (title, then plate). Otherwise it raycasts the world through the camera in effect and returns `{ id, point }`.
- A camera override moves only the world layer. Because the plate is opaque, its pixels can be tested directly.

**Run:** `shaderera check --times 10`, `shaderera inspect --time 2`, `shaderera render`. `apps/cli/src/camera/fixtures.test.ts` covers the round trip (max 0) and checks that, under another t's override, no pixel inside the plate box changes while pixels outside it do.
