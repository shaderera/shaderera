# A product in 3D

For requests about a physical product shown in 3D: a supplied model, an original object.

## The subject decides the route
- **A supplied model** (GLB or glTF + textures): import it as the subject and keep its geometry
  and materials. Report unsupported features (Draco, KTX2, meshopt, skins, morph targets) instead
  of dropping them, and put the model report in `inspect().subject`. The `render-gltf-read`
  plugin reads one into plain arrays, refuses what it cannot read and lists what it leaves out.
- **A real product with no model:** do not build a stand-in and call it the product. Say the model
  is missing (a `blocked` or `missing` item in requirements.json), and offer the photo route
  (`guides/photo.md`) if a photo exists.
- **An original object** the brief asks you to design: build it in its own module, and label it
  original in `inspect().subject` and the summary.

## Rendering
- The renderer is the film's choice: WebGPU on `host.gpu`, three.js (the `render-three-host` plugin puts
  its WebGPURenderer on the host's device), a ray or path tracer, or anything else. Return the
  frame as a `GPUTexture` layer to skip a copy.
- Judge materials and light on final-quality frames (`npx shaderera still <t>`, or MCP
  `render_frame` with `final: true`), not on previews.
- A metal face turned to the camera mirrors what is behind the camera, usually the dark
  background, and goes black. Raise the environment intensity or the roughness, or bring the key
  light near the view axis.
- A field of view is not a lens: "70 mm" needs a sensor size to convert; say which you assumed.
- Report the camera in `inspect`; a camera a 4×4 view and projection describe may also implement
  `camera` for the debugging tools.

## Check
Review (frames, `blank-frames`, `end-hold`, `readback`), then look at the moments that matter at
full size.
