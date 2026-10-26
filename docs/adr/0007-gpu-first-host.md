# 0007: GPU-first host, parallel export

2026-10-09. Owner approved.

**Observed problem.** An export spent about 90% of each frame on the CPU after the GPU had drawn
it (measured 2026-10-09). Per 1080p frame, a product film spent 7–13 ms in the source and about
75 ms in work after it:

- readback of every layer;
- JS `over`, `straight` and `matte` loops over 8.3 MB;
- IPC;
- swscale in ffmpeg.

In the browser host, the base64 transfer over CDP took 90–190 ms per 720p frame and the DOM
capture's rAF waits took about 100 ms. The design planned GPU compositing
("returns a `GPUTexture` with no copy"); the first release deferred it and composited on the CPU.

**Measurement.** On Dawn at 1920×1080, uploading a CPU layer and running one compute pass took
4.6 ms in all. The pass does `over`, matte, and RGB→Y'CbCr 4:2:0 BT.709 limited range, then
reads back 3.1 MB. Parallel hosts gave 1.8–5× on the CPU path alone.

**Decision.**

1. **The host composites on the GPU** when it has a `GPUDevice`. That is always true in the
   browser host. In the Node host it is true when the project installed `webgpu` (0002 is
   unchanged).
   - A layer may be a `GPUTexture` from `host.gpu`: no copy.
   - Canvases, bitmaps, video frames and bytes are uploaded once.
   - `over` and the depth test run in compute passes in `@shaderera/core/host`
     (`gpuCompositor`), shared by both hosts.
   - Without a device, the Node host composites with Skia (`drawImage`). It keeps JS `over`
     only for layers with depth.
2. **An mp4 export asks for `yuv420p`.** The host mattes over black and converts to Y'CbCr
   4:2:0 BT.709 limited range on the GPU. ffmpeg takes it as is (no swscale), tagged as before.
   The determinism hashes are taken on these bytes. RGBA (straight) stays the default output for
   PNG, diffs and checks.
3. **Parallel export.** `render --workers N` opens N hosts and interleaves frames, which are
   written to ffmpeg in order. The default is `min(4, cores − 2, frames / 30)`. A `sequential`
   source always uses 1. The 8-frame revisit runs on host 0, so the hosts must agree with each
   other too.
   - (Amended 2026-10-27, #447/#448: the revisit is one frame a second of film, spread evenly
     over the hosts already open and run on them at once. A frame is re-checked on a host other
     than the one that first rendered it, and each host shuffles its own share, so
     order-dependent pixels are still caught and the hosts must still agree. On host 0 alone it
     ran in series, a random seek a frame on footage: 7.4 s after an 8 s render of a 20 s 1080p
     film. Spread, a footage seek is still a decode from the keyframe before it, which uses the
     CPU, so it gains what cores are idle; short-GOP footage is #450. The progress line says
     `re-checking 12/20` meanwhile. A `sequential` source, on one host, re-checks 8 frames of
     the grid at most: each frame out of order can cost a replay from frame 0.)
4. **Browser host transfer.**
   - The runner worker POSTs the frame's bytes to the runner server (`'self'`), not base64
     over CDP.
   - The DOM snapshot waits for the canvas `paint` event, not for 4 rAF. The settle check (two
     equal snapshots) stays.

5. **NVENC for a review** (owner, 2026-10-09). A review encode uses `h264_nvenc` where ffmpeg
   and the machine take the frame size; otherwise, and always for a master, it uses x264.
   `--encoder` chooses. On that product film, 4 hosts: 9.8 → 7.7 s. The file is 52% larger, at
   PSNR 46.9 dB against the x264 file and the same mean luma.

**Public API impact.** `Layer.color` may be a `GPUTexture` (from `host.gpu`). `Child.render`
takes an output format. CLI `--workers`.

**How to reverse.** Hosts fall back to the CPU paths, which stay for device-less Node.
