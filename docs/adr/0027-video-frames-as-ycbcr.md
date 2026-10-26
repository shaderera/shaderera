# 0027: Video frames as Y'CbCr planes, converted by core in WGSL

2026-10-27. The owner approved the direction (#452); this ADR comes before the implementation.
Amends [0007](0007-gpu-first-host.md) and the `Io` contract (`Footage.frame`).

**Context.** `io.video` hands every frame over as straight RGBA: 8.3 MB at 1080p, 33 MB at 2160p.
- The CLI's decoder converts each frame to full-range RGBA in ffmpeg
  (`apps/cli/src/node/decoder.ts`: `scale=in_color_matrix=auto:in_range=auto:out_range=full,format=rgba`).
  Converting and piping is about two thirds of its work per frame; decoding is the other third.
- The frame goes to the CLI's thread (`video-worker.ts`, `services.ts`), and then to the host.
  A Node host gets it on the bulk pipe (`bulk.ts`), a browser host over the runner server
  (`runner-plugin.ts`, `runner/worker.ts`).
- In #434's audit, a film that only fetches frames peaked at about 70 fps in the Node host and
  42 fps in the browser host at 1080p. A GPU film hits exactly that ceiling.
- More hosts do not lift it: in #436, 12 hosts added 12–20 %.
- A film that draws footage on the GPU uploads those RGBA bytes once (0007), so it needs no RGB
  from the CPU at all.

Y'CbCr 4:2:0 is 1.5 bytes a pixel against 4: 3.1 MB at 1080p, 2.7× less at every size. It is also
what an H.264 or HEVC file decodes to. For an 8-bit 4:2:0 file ffmpeg then converts nothing.

**Decision.**

1. **`frame(i, { format: 'yuv420p' })`: the file's Y'CbCr, in planes.**
   - **The call.** `Footage.frame(index, options?)` takes `{ format?: 'rgba' | 'yuv420p' }`.
     It still resolves to one `Uint8Array`. The bulk pipe, the runner server's
     `video-frame` route and the web player's answer carry bytes as they are; the request
     gains `format`.
   - **The layout.** I420: the Y plane, then Cb, then Cr. Rows run from the top, with tight
     strides and no padding.
     - Y is `width` bytes a row and `height` rows.
     - Cb and Cr are each `cw = ceil(width / 2)` bytes a row and `ch = ceil(height / 2)` rows.
     - Length: `width × height + 2 × cw × ch` (3 110 400 at 1920×1080).
     - A film uploads each plane with `writeTexture` and `bytesPerRow` set to the plane's width:
       `writeTexture` needs no 256-byte rows.
   - **The colour, as the decoder made it.** `Footage` gains `colour`, read once when the clip
     opens:
     - `matrix`: `'bt709' | 'bt601' | 'bt2020nc'`;
     - `range`: `'limited' | 'full'`;
     - `chroma`: `'left' | 'center' | 'topleft'`.

     These are always resolved values, never "unspecified". An untagged file gets the matrix and
     range the RGBA path's `in_color_matrix=auto:in_range=auto` uses for it. Its chroma siting
     is the codec's default: left for H.264 and HEVC, center for MJPEG. They describe the planes
     handed over, which may differ from the file (see the next point).
   - **What ffmpeg does to the file.** The decoder keeps the file's matrix and range. It changes
     only the pixel format, to `yuv420p` (`scale=out_range=<the file's>`, `format=yuv420p`).
     - An 8-bit 4:2:0 file passes through with no conversion.
     - A 4:2:2 or 4:4:4 file (ProRes, DNxHD) is subsampled by swscale. `chroma` is then the
       siting of what swscale made.
     - A 10- or 12-bit file is reduced to 8 bits, as the RGBA path already does.
     - The bytes are software ffmpeg's, the same every time, as they are for RGBA today.
   - **Refusals.** `yuv420p` has no alpha. A clip whose pixel format carries alpha (ProRes 4444
     with alpha, `yuva*`) refuses `yuv420p` and names `rgba`. Losing the alpha silently would
     be a look made without the author.
   - **The decoder serves one format a clip.** The shared decoder in `services.ts` is keyed by
     file and format. A film that asks both formats of one clip runs two decoders.
   - **Decoding ahead stays at 64 MiB.** `AHEAD_BYTES` counts the format's frame size, so a
     `yuv420p` decoder runs 2.7× more frames ahead.
   - **The web player.** Its proxy is already H.264 `yuv420p`, BT.709 limited
     (`player/media.ts`). It hands the WebCodecs frame's planes over as I420. H.264 decoding is
     exact by the standard, so these are the proxy's own bytes. If the decoder gave NV12, the
     player splits it into I420. The proxy is still not the original, so the player stays close
     to the CLI's bytes, not equal (as docs/player.md says today).

2. **`videoTexture(device, clip)` in `@shaderera/core/gpu`: core's conversion, not the driver's.**
   - **What it is.** A helper beside `readTexture`, in the same experimental entry. It is
     optional: a film may upload the planes and convert them in its own shader.
     - `videoTexture(device, clip)` returns `{ frame(i): Promise<GPUTexture>, destroy() }`.
     - `frame(i)` asks for `yuv420p` and uploads the three planes into `r8uint` textures. It then
       converts them in a WGSL compute pass into an `rgba8unorm` texture at the clip's size:
       straight, opaque, sRGB code values, full range.
     - The output's usage is `TEXTURE_BINDING | STORAGE_BINDING | COPY_SRC`. When the clip is the
       frame's size, the texture can be a `GPUTexture` layer as it is (0007, no copy).
   - **Ownership.** The helper owns its textures. The texture `frame(i)` returns stays valid
     until the next `frame()` or `destroy()` of that helper. A film that holds two frames at
     once (a dissolve) makes two helpers.
   - **The conversion: the planes' own colour, in integers.** It uses `clip.colour`'s matrix
     (Kr and Kb from BT.709, BT.601 or BT.2020 non-constant luminance) and its range: limited is
     Y 16–235 and C 16–240, full is 0–255.
     - **Chroma upsampling.** The chroma is upsampled bilinearly from where `chroma` sites it, with
       edges clamped:
       - `left`: co-sited across, so a luma column takes its own chroma sample or the mean of two.
         Between rows down, so the weights are 3/4 and 1/4.
       - `center`: between samples both ways, so the weights are 3/4 and 1/4 across and down.
       - `topleft`: co-sited both ways.
     - **Integer arithmetic.** The pass computes in `i32` fixed point with 16 fractional bits,
       rounds half up and clamps to 0–255. It writes `k / 255.0`, which every implementation's
       `unorm8` store turns back into `k`.
     - **Why integers.** WGSL lets an implementation fuse `a * b + c` into an fma, so float
       arithmetic could differ by one code between Dawn and Chrome. Integer arithmetic cannot.
       The same WGSL in the Node host and the browser host therefore gives the same bytes, which
       the determinism check and 0007's agreement between hosts need.
   - **Exactness.** A TypeScript reference runs the same integer formula. A core GPU test and the
     browser host's contract test must match it byte for byte. The fixtures are:
     - each matrix in both ranges;
     - each chroma siting;
     - hard colour edges;
     - odd widths and heights;
     - the code extremes (0, 16, 235, 240, 255).
   - **Not equal to `frame(i)`'s RGBA.** swscale upsamples chroma and rounds in its own way, so
     the helper's bytes are not the RGBA path's. A test bounds how close they are (PSNR) on the
     same fixtures, which also proves the matrix and range the CLI reports are the ones ffmpeg
     used. A film chooses one path. Switching it from RGBA to `videoTexture` changes its pixels
     once, like any edit.
   - **Without a GPU.** `videoTexture` needs a `GPUDevice`. A Node host without `webgpu` can
     still ask for `yuv420p` and convert the planes in its own code.
   - **WebCodecs `importExternalTexture` is rejected for renders.** How it converts (the matrix,
     the range, the chroma filter) is left to the implementation and the driver. It does not
     exist in Node either. A film may use it only in a preview that no render, check or hash
     reads.

3. **RGBA stays the default.** `frame(i)` with no options, or `{ format: 'rgba' }`, gives the same
   bytes as today, decoded the same way. Every existing film, plugin, hash and test stays as it
   is. `yuv420p` and `videoTexture` are opted into by the film's code. No manifest field is
   needed, because the choice belongs to the film's code, not to a job.

4. **What this amends.**
   - **0007 §1** said canvases, bitmaps, video frames and bytes are uploaded once, as RGBA. A
     video frame may now arrive as Y'CbCr planes. Core converts them to RGB on the GPU, the
     reverse of 0007 §2's RGB→Y'CbCr pass. It lives in `@shaderera/core/gpu`, shared by both hosts
     like `gpuCompositor`, and is held to an integer reference in TypeScript.
   - **0007's "Public API impact"** gains `Footage.frame(i, { format })`, `Footage.colour` and
     `videoTexture`.
   - **The `Io` contract** (`packages/core/src/protocol.ts` `Footage`, docs/protocol.md
     `io.video`) changes as in point 1. Hosts other than Shaderera's that offer `io.video` must
     accept the option. A host that cannot give planes throws a message that names the format.
   - **0023 is unchanged.** An `io.video` layer, from either path, stays an SDR layer of sRGB
     code values, mapped to `graphicsWhite` in an `hdr10` render.

**Not decided here (later, each when a film asks).**
- **`yuv420p10`.** 10-bit planes in P010's layout, the layout 0023's encoder already takes:
  6.2 MB at 1080p, still under RGBA's 8.3 MB. Together with PQ and HLG footage, this is the
  route for HDR footage into an `hdr10` render (0023 notes that PQ footage arrives today as
  wrong sRGB codes). It needs its own light declaration, so it is its own decision.
- **Shared memory, or a pipe from the decoder straight to the host** (#436's item 3), which
  would remove the CLI thread's copy.

**Rejected.**
- **Normalising every clip to BT.709 limited**, as the player's proxy does. It costs a swscale
  pass on every file that is not BT.709 already, and changes their colour twice.
- **NV12** (interleaved CbCr). It is the same size, but I420 is what ffmpeg's `yuv420p` and
  WebCodecs' software frames give without a copy, and each plane uploads as one `r8uint`
  texture.
- **Float arithmetic in the WGSL pass.** fma contraction lets two WebGPU implementations
  differ.
- **Returning planes as three buffers or an object.** The transport and `Footage.frame`'s type
  carry one `Uint8Array`, and the layout above is fixed.

**Verify before implementation.**
- Which matrix and range ffmpeg 8.1's `scale` with `in_color_matrix=auto:in_range=auto` uses
  for an untagged file (swscale's default has been BT.601 limited). `colour` must report that.
- That `scale=out_range=<the file's>,format=yuv420p` keeps a full-range MJPEG (`yuvj420p`) full
  range, and keeps a BT.601 file's matrix untouched.
- Which chroma siting swscale's 4:2:2→4:2:0 output has, so `chroma` reports the planes'
  siting and not the file's.
- That Chrome's `VideoFrame.copyTo` gives I420 for the player's proxy, or NV12 that the player
  splits.
- The ceiling it lifts. The issue expects up to 2.7× on the transport. Decoding and the upload
  then bound it. The implementation PR measures #434's fetch-only film at 1080p and 2160p in
  both hosts.

**How to reverse.** Everything is behind the `format` option and the helper. Removing them leaves
`frame(i)`'s RGBA path as it is.
