# 3d-product fixture

An engineering fixture for the CLI's tests. 1920×1080, 30 fps, 6 s. It uses three.js primitives on `WebGPURenderer` (`host.gpu`), rendering into a render target that is read back as opaque bytes.

**Exercises:**
- **Camera keys** are four stamped literals in one array (`{ id: 'k1', at, eye, target, fov }`). The camera eases between neighbouring keys.
- `inspect(t)` returns `parts` (`{ id, space: 'world', position, ... }`) and `camera: { id: 'camera', eye, target, fov, override, keys }`. `keys` holds the two keys bracketing t, spread from the array so each keeps its `source` for Apply view.
- `pick(t, x, y)` raycasts through the camera in effect (the override, when one is set) and returns `{ id, point }`.
- `camera.get(t)` returns the authored camera's matrices in WebGPU clip space, even while an override is set. `camera.override(m | null)` applies the given matrices exactly.

**Run:** `shaderera check --samples 10`, `shaderera inspect --time 2`, `shaderera render`. `apps/cli/src/camera/fixtures.it.ts` covers the round trip (max 0 at three t) and a pick at a part's projected centre.
