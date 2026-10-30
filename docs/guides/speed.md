# Speed: expensive films, footage and stills

For requests about a film whose frames take seconds, that is rendered partly outside the host,
or that puts footage and stills on screen. The reference is `docs/cli.md` (`render`) and
`docs/participants/webgpu.md`.

## Expensive films

A film whose frames take seconds, or that is rendered partly outside the host, needs a few flags
that already exist. Use them, and tell the person what is running and how far it is: a long
command that prints nothing looks frozen.

- **Keep `open` light.** `open` runs in every host: each `--workers` host of a render, each chunk,
  each `still`, `check` and `review`. Work only `audio()` needs (a music bed made in code, a mix)
  goes in `audio()`, which runs once and only when the sound is wanted: a 28-minute film that
  made its bed sample by sample in `open` paid 57 s in every host for frames that never used it.
  Derived bytes that are the same every run (a decoded pyramid, an analysis) go through
  `io.cache`, so they are made once, not once a host.
- **Close each clip when its shot ends.** A clip's decoder holds its buffers until `close()` or
  the end of the render, in every host: a film of about 60 clips that closed none grew to about
  3.5 GB a host and could not run more than three. `frame(i)` after `close()` opens it again, with
  the same bytes.
- **Per-pixel work on the GPU.** A pass over every pixel in JavaScript (`getImageData`, a loop,
  `putImageData`) cost 51 ms a 1080p frame on a quiet machine and 127 ms on a loaded one; the
  same levels or grade in a WGSL pass over `host.gpu`, or a `look-*` plugin, costs well under one.
  Footage and stills go on the GPU the same way ([below](#footage-and-stills-on-the-gpu)).
- **Call a heavy WGSL function from one site.** The browser inlines every call, so a large
  function called from several places compiles once per place and a pipeline can take seconds
  before the first frame (`guides/shader-compile.md`).
- **Measure before guessing.** `NODE_OPTIONS=--cpu-prof npx shaderera render --trusted --from 10
  --to 14` writes one `.cpuprofile` for the CLI and one for each host (without `--trusted` a host
  cannot write it): open them in Chrome DevTools, Performance, and see whether the time is in
  `open`, in the film's draw or waiting.
- **Few layers, on the GPU.** Each frame's layers are composited and the frame read back from the
  GPU and handed to the CLI in every host. When `render`'s time line says the compositor and
  readback take most of each frame, return fewer layers, return GPU textures rather than canvases
  (a canvas is uploaded every frame), and use more hosts (`--workers`, below).
- **Check with fewer frames.** `check` renders every timestamp twice; at 5 s a frame, the default
  50 take over eight minutes. `npx shaderera check --times 4` still compares two orders.
- **Render in the background with progress:** `guides/review.md`.
- **More hosts on a big machine.** `render` opens at most 4 hosts; when to give more
  (`--workers`) is in `docs/cli.md`, `render`.
- **Bake what the host cannot run.** When a frame needs a program project code may not start (a
  native denoiser that keeps history, a simulation in another tool), or minutes of work that
  another program does better, make those frames a bake: declare it in `shaderera.json` `bakes`
  (the command, its inputs, the folder, how the frames are named; `docs/protocol.md`, "Bakes"),
  run `npx shaderera bake <name>`, and read the frames with `io.bake(name)`. Every command that
  renders refuses a bake whose inputs or frames changed since it was made, and a job pins it.
  Never read such frames with `io.read` and a cache you clear by hand: nothing would tie them to
  the code that made them.
- **Compare a final with what was approved.** Before handing over a final, put it beside the
  approved variant: `npx shaderera still 4 16.9 --variant final --compare animatic --sheet`. It
  writes each pair side by side with PSNR and mean ΔE; it measures and never judges, so look at
  the pairs and say what differs.

## Footage and stills on the GPU

On a film with `host.gpu`, put footage and stills on textures and draw them with a WGSL pass.
Keep Canvas2D for type and small shapes. A footage frame put on a canvas and drawn scaled, or a
large still drawn with `drawImage`, costs time every frame: 10–24 ms to draw an 8000 px still into
1080p (21–51 ms with `'high'` smoothing). Measured at 1080p in Node on 4 hosts, a Canvas2D film
ran at 49 fps on a quiet machine and 22–27 when loaded; the same picture as textures and one WGSL
pass ran at 70 and 48.

```ts
// in open: a still is written once
still.write(first, image.data as Uint8Array)

// in render(t): the footage frame, then one pass each into the output texture
const data = await clip.frame(Math.min(clip.frames - 1, Math.floor(t * clip.fps)))
const encoder = device.createCommandEncoder()
footage.write(encoder, data) // writeTexture, then its mip levels halved
const back = fit(footage, 'cover')
drawFootage(encoder, back.rect, back.lod + 5, 1) // cover, read 32× smaller: a blurred backdrop
const front = fit(still, 'contain', 0.6)
drawStill(encoder, front.rect, front.lod, 0, false) // the whole still, over it
device.queue.submit([encoder.finish()])
return { color: output, alpha: 'premultiplied' }
```

For footage drawn on the GPU, `videoTexture(host.gpu, clip)` from `@shaderera/core/gpu` asks
for the clip's Y'CbCr planes (1.5 bytes a pixel, not RGBA's 4: footage-heavy films render faster)
and converts them on the GPU, the same bytes in every host. Its `frame(i)` gives an `rgba8unorm`
texture to sample in place of `footage.write`; it is valid until the next `frame()`, so a
dissolve between two frames uses two helpers. Its pixels are close to `clip.frame(i)`'s RGBA,
not equal: switching a film changes its pixels once.

`docs/participants/webgpu.md`, "Footage and stills", has the whole film: the WGSL pass, `picture`
(a texture with mip levels), `fit` (cover and contain as a uv rectangle) and `pass`. Never blur by
drawing a frame to a tiny canvas and back up: it is slow, and with `'high'` smoothing its pixels
can depend on what was drawn before.
