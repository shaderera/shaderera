# 0009: No camera model in core

2026-10-10. Owner accepted.

**Question.** Should core have a camera? Cameras come in many kinds:
- perspective and orthographic;
- fisheye, 360° and panoramic projections, which no 4×4 matrix describes;
- a Canvas2D film's pan and zoom, or no camera at all;
- several cameras in one frame (split screens, a film inside the film);
- lenses with focus, aperture, shutter and shift.

**What core has.** Core has no camera model. It has an optional hook:
- `Source.camera?: CameraCapability`, with `get(t)` and `override(m | null)`;
- `RenderOptions.camera?: Matrices`;
- `Matrices { view, projection, up? }`, in WebGPU clip space.

The hook serves debugging and review tools: MCP's `get_camera` and `render_frame` with a camera, a
free camera (the Studio's, on hold), and jobs refusing an inspection camera in an export. Rendering,
determinism, export and delivery work on pixels and never need a camera.

**Decision.**
1. **Core has no camera model, and gets none.** How a camera moves, its lens and its kind are
   creative work, so they belong to the project's code. A model in core would hold back every
   film it does not fit.
2. **The hook stays, optional and frozen.** It is not extended: no lens fields, no kinds, no
   multiple cameras. It covers cameras a 4×4 view and projection can describe. A source with any
   other camera, or several, leaves `camera` out and reports them in `inspect`, which takes any
   JSON.
3. **Camera models are registry items**, written as our own MIT code (`motion-keyframes`,
   `camera-keyframes`, `camera-shake`). Each one implements the hook as an option, so MCP can debug
   it. three.js/pmndrs libraries were studied and not taken as dependencies, because their
   damping steps per frame and is not a pure function of t.
4. **The override half may later move out of core** into the MCP host (and the Studio, on hold):
   the override is the only part that makes the render path aware of a camera. Decide
   this at the next major version, not now.

**Consequences.** Nothing changes in code except the comment on `Matrices` in `protocol.ts`, which
now says the hook is frozen and optional. Films keep whatever camera they write, and the registry
offers ready ones.
