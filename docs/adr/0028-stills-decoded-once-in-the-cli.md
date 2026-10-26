# 0028: Stills decoded once in the CLI, by one WASM module, at the size used, and cached

2026-10-27. Proposed (#453). The owner approved the direction, ADR first. The maintainer decided
its open questions the same day (PR #457) and, after the experiment in #469, switched the
decoder to Rust compiled to WASM. Amends 0007 (parallel export).

**Context.** `io.image` decodes PNG and JPEG in JavaScript (fast-png, jpeg-js) inside each host
(`apps/cli/src/runner/image.ts`, at `ff492b2`). So the bytes are the same in the Node host, the
browser host and the web player. But each host decodes:
- at full resolution, with no size option;
- once per file, per host, per command;
- with no cache.

The media audit of #434 measured the cost. An 8000×6000 JPEG takes 1.7 s (quiet machine) to
3.9 s (loaded) and 192 MB per host. The usual `putImageData` into a canvas adds 0.15–0.4 s and
another 192 MB. The film in #434 had about 20 such stills, so every `still`, `check` and `render`
spent 35–78 s in `open`, in each host. `render --workers 4` paid that four times.

`io.video` already works the other way. The CLI's process decodes a clip once and hands the
frames to every host (`apps/cli/src/node/services.ts`, `shared`). `io.cache` keeps derived bytes
in `.shaderera/cache/`, at most 1 GiB, evicting the least recently used. Twenty full-size stills
(3.8 GB) would thrash that cap on every run.

**The experiment (#469, 2026-10-27).**
- **What was built.** `zune-jpeg` 0.5.15 and `zune-png` 0.5.2, default features off (no SIMD),
  built with wasm-pack 0.13.1 (`--target web`), with this ADR's box filter in the same module.
- **Where it ran.** One `.wasm`, loaded in Node 24.14 and in a module worker in headless
  Chrome 156.
- **How it was timed.** Median of 9 warm runs, against jpeg-js and fast-png. The machine was busy,
  so the ratios matter, not the absolute times.

| image | maxSize | jpeg-js / fast-png | WASM in Node | WASM in Chrome |
|---|---|---|---|---|
| JPEG 8000×6000 | full | 4896 ms · 945 MB | 826 ms (5.9×) · 659 MB | 1173 ms (4.2×) · 661 MB |
| JPEG 8000×6000 | 2560 | 5997 ms · 945 MB | 1097 ms (5.5×) · 408 MB | 1357 ms (4.4×) · 413 MB |
| PNG 6000×4000 | full | 3137 ms · 401 MB | 566 ms (5.5×) · 657 MB | 561 ms (5.6×) · 661 MB |
| PNG 6000×4000 | 2560 | 3641 ms · 401 MB | 682 ms (5.3×) · 507 MB | 754 ms (4.8×) · 513 MB |

The memory column is peak resident memory, Node or Chrome included.

- **The bytes.** The same from WASM in Node, WASM in Chrome and a native build, in all four
  cases.
- **PNG** comes out identical to fast-png.
- **JPEG** differs from jpeg-js in 59% of samples, by a mean of 4.3 codes and at most 157 (on
  noise). zune smooths chroma upsampling, where jpeg-js repeats the samples.
- **The filter.** A JS port of the box filter gives the same bytes as the Rust one.
- **Size.** The `.wasm` is 233,188 bytes (91 KB gzipped).
- **The SIMD build** (`simd128`) gave no measurable gain.
- **Licences.** zune-* are MIT, Apache-2.0 or Zlib; simd-adler32 is MIT; wasm-bindgen is MIT or
  Apache-2.0.

**Decision.**

1. **The CLI's process decodes a still, once for all hosts.**
   - `io.image` becomes a service request, like `video-open`. The Node host asks over IPC, the
     browser host's worker over the runner server.
   - The decode runs in a worker thread of the CLI, not on the thread that serves every host's
     video frames and cache. A slow decode must not stall a clip.
   - Several hosts asking for the same still at the same time share one decode. The CLI keeps
     the decoded still in memory while a host of the command that asked for it is open, as it
     keeps a clip's decoder (`shared`), and drops it when the last one closes.
   - The web player has no CLI. Its worker answers `io.image` itself from `files/`
     (`player/services.ts`), with the same module (2), and gets the same bytes as the CLI.
   - `io.bake`'s `image(i)` still decodes in the host, at full size, with the same module, so it
     stays "decoded as `io.image` decodes" (0016).

2. **The decoder is one Rust→WASM module: zune-jpeg, zune-png and the box filter.**
   - **The interface.** One call, `decode(bytes, maxSize)`, returns straight RGBA at 8 bits, or
     16 for a 16-bit PNG. It replaces fast-png and jpeg-js.
   - **One `.wasm` everywhere.** The CLI's decode worker, the browser host and the web player all
     load it. #469 measured the same bytes in Node, in Chrome and natively.
   - **The build.**
     - Default features are off, and so is SIMD: it gained nothing, and scalar code is one path
       to keep identical.
     - The pipeline is integer-only.
   - **Exact versions.** The crate versions are pinned exactly in `Cargo.toml` and `Cargo.lock`
     (zune-jpeg 0.5.16 is in rc). A bump is deliberate, and it changes the decoder-version tag
     in the cache key (5).
   - **Memory.** A WASM instance's memory grows and never shrinks: #469 measured 209 MB after the
     JPEG and 368 MB after the PNG. So the CLI decodes in a worker it drops after each decode or
     batch, or it recreates the instance. The web player does the same in its worker.
   - **Shipping it.** The build gains a Rust and wasm-pack step, in CI too. The built `.wasm`
     ships in the `shaderera` npm package, so a person needs no Rust.
   - **Benchmark before implementing.** #469 benchmarked an 8-bit JPEG and an 8-bit RGBA PNG.
     Benchmark 16-bit PNGs and 1, 2 and 4-bit PNGs against fast-png first. A case that is slower
     or different is reported on #453 before the switch.

3. **Existing films' stills change slightly, accepted as a correction.**
   - **JPEG.** A JPEG still's pixels change even without `maxSize`, because of the chroma
     upsampling above. zune's smoothing is the one the JPEG reference and libjpeg use by
     default. jpeg-js's repeated samples were the outlier.
   - **PNG transparency.** An RGB or grey PNG with a `tRNS` chunk now gets its transparency.
     fast-png's path ignored it, which was a bug.
   - **Saved work.** Frozen jobs are unaffected: `render --job` refuses a job made by another
     Shaderera version.
   - **The release notes say so.** They name both changes, and say that a film's renders
     after the upgrade can differ slightly where it uses a JPEG still or a PNG with `tRNS`.

4. **`io.image(path, { maxSize })`: the still at the size the film draws it.**
   - **The size.** `maxSize` is a whole number of pixels. The long side becomes exactly
     `maxSize`, and the short side becomes `max(1, round(short × maxSize / long))`, so the aspect
     is kept.
   - **It only shrinks.** A still already within `maxSize` comes back as it is, the same bytes as
     without the option. Without `maxSize`, `io.image` gives the full size.
   - **Bit depth is kept.** A 16-bit PNG shrinks at 16 bits.
   - **The film chooses the size:** the largest it ever shows the still, in output pixels. A Ken
     Burns push to 1.3× on a 1920×1080 frame needs about 2500, not 1920. The engine does not
     guess it.

5. **One filter: area average (box), weighted by alpha, in the file's code values, in exact
   integer arithmetic.** It lives in the same module as the decoders.
   - **How it works.** Each output pixel is the average of the source pixels under its footprint,
     each weighted by the area it covers. This is the filter of OpenCV's `INTER_AREA` and
     Pillow's `BOX`.
   - **Alpha.** Colour is weighted by alpha (premultiplied), so a transparent pixel's hidden
     colour doesn't bleed into edges. The result is straight again. Where the alpha sum is 0, the
     colour is 0.
   - **Exact integer arithmetic.** It is separable: rows, then columns. The coverage weights are
     whole numbers (in units of 1/(source × output) pixel). Each pass rounds half up, once. A
     test pins known bytes.
   - **Why a box.**
     - **Byte-identical everywhere.** It needs only integer adds, multiplies and divides, which
       have one answer on every machine and engine. Lanczos and bicubic need `sin` or float
       weights, which a port to JavaScript, or another libm, can round differently. #469's JS port
       of the box gave the same bytes as the Rust one.
     - **It is the right filter for shrinking.** Every source pixel counts once, so fine detail
       averages instead of aliasing.
     - **No overshoot.** A box has no negative lobes, so there are no ringing halos round a
       logo's edge and nothing to clamp. Sharpening is a look, and the film's (0011).
     - **The same choice as the rest of the engine.** Like Canvas2D's smoothing, `image-fit`'s
       pyramid and a GPU's sampling of an `rgba8unorm` texture, it averages code values, not
       linear light. A still shrunk by `maxSize` looks like the full one drawn small.
   - **Fixed, not an option.** One filter is one set of bytes to test. A film that wants another
     filter decodes at full size and shrinks the still itself, or keeps it in `io.cache`.

6. **The cache key: the file's content hash, the decoded size and the decoder's version.**
   - **The key.** `sha256` of a fixed tag naming the decoder version, the file's sha256, and the
     decoded `width×height` and bits.
   - **The content hash, not the path or the time.** A file edited in place, or a copy under
     another name, is keyed right. This is how `io.cache` keys its inputs, and how 0016 checks
     bakes. Hashing a 10 MB JPEG takes milliseconds against hundreds of decoding.
   - **The decoded size, not `maxSize`.** On a 3000 px still, `maxSize` 4000 and 5000 give the
     same pixels, so they share one entry. The size is enough because the filter is fixed.
   - **The decoder's version.** The tag changes on every bump of a crate or the filter (2), so an
     upgrade makes new entries rather than serving old bytes.
   - **The entry.** The decoded RGBA, raw, with its width, height and bits. Reading it back costs
     a file read, not a decode.

7. **The cache is sized by the decoded size, and keeps the 1 GiB cap.**
   - **Where.** Entries live in `.shaderera/cache/` beside `io.cache`'s, under the same limit
     (`SHADERERA_FILM_CACHE_MB`), and are evicted the same way.
   - **What a still costs.** With `maxSize`, a still costs what it shows. At 2560 px it is
     14.7 MB at 8 bits, so twenty fit in under 300 MB.
   - **Too big to keep.** An entry larger than one eighth of the limit (128 MiB at the default)
     is not written: it would push out up to eight others on every run. Such a still is still
     decoded only once a command, in the CLI, rather than once a host.
   - **No warning of its own.** #454's lint for per-frame CPU pixel work warns about a still
     decoded far larger than the film shows it (the 8000×6000 photograph in a 1080p film). There
     is one warning, not two.

8. **GPU mips are deferred. `image-fit` keeps its CPU pyramid.**
   - **Canvas2D without a GPU.** `image-fit` is a Canvas2D plugin, and it must run in a Node host
     without `webgpu` (0002, 0007). A GPU mip chain can't replace it there.
   - **Host agreement.** WebGPU has no `generateMipmap`. A chain made by a render or compute pass
     samples with a precision the spec leaves to the implementation. So Dawn in Node and Chrome on
     another adapter need not agree to the byte, and today they do.
   - **The cost falls anyway.** With `maxSize`, the pyramid's cost falls with the pixels. A
     2560×1440 still has about a thirteenth of an 8000×6000's pixels, and the pyramid is built
     once in `open`.
   - **Films on the GPU.** A film on the GPU makes its own mips, as `render-three-textures` lets
     three.js do. A plugin that makes a mip chain on the device (one job, plain data in and out)
     comes when a film needs one, not before.

**What changes in `docs/protocol.md`.**
- `Io.image` becomes `image?(path: string, options?: { maxSize?: number }): Promise<DecodedImage>`,
  in the type block and in `packages/core/src/protocol.ts`.
- The `io.image` bullet now says:
  - the decoder is one WASM module (zune-jpeg, zune-png), in place of fast-png and jpeg-js;
  - the CLI's process decodes the still, once a command for every host, in a worker of its own;
  - `maxSize` and its rounding;
  - the filter, by name, and that colour is 0 where the alpha sum is 0;
  - the cache entry, its key, and the one-eighth rule;
  - the web player's worker decodes with the same module and gets the same bytes.

  It drops "once per file in a host".
- The `io.cache` bullet says the cache also holds decoded stills, under the same limit.
- The bullet on what runs in the CLI's process ("Project code cannot write files…") adds the image
  decoder.
- `docs/player.md` adds an `io.image` line: decoded in the worker from `files/`, by the same
  module, the same bytes as the CLI.
- `docs/authoring.md` (the table row for images) tells films to pass `maxSize`: the largest size
  the film shows the still.
- `README.md`'s Develop section names the Rust and wasm-pack step.

**What amends 0007.** Decision 3 (parallel export) now shares a still's decode between the N
hosts, as one decoder of a clip already serves them. N hosts no longer cost N decodes of every
still, and the hosts still agree, because they receive the same bytes. 0007's GPU compositing
and its uploads are unchanged: an `io.image` is still CPU bytes that a layer uploads once.

**Rejected.**
- **Keeping jpeg-js and fast-png.** They are 4–6× slower than the WASM module (#469), and they
  have the `tRNS` bug.
- **ffmpeg or sharp (libvips) in the CLI.** Native libvips can also shrink a JPEG while decoding
  it, in the DCT. But the web player can't run either, so a shared film would show other bytes.
  ffmpeg would also become a requirement for films with stills and no footage, and libvips's
  bytes change with its versions. The WASM module came close to native speed in #469 (826 ms
  against 492 ms on the 8000 px JPEG) and runs everywhere.
- **The SIMD build.** It gained nothing in #469 and would add a second path to keep identical.
- **A default `maxSize`** (the output size, say). It would guess wrong for any still that is
  zoomed.
- **Lanczos or bicubic.** See 5.
- **Linear-light averaging.** It is closer to how light adds, but it disagrees with every other
  shrink in the engine and needs `pow` or a table per bit depth. The filter averages code values
  (maintainer, 2026-10-27).
- **Caching every decode whatever its size.** One 384 MB 16-bit still would push out most of a
  film's cache on every run.

**Later, if a film needs it** (out of scope here; maintainer, 2026-10-27).
- **`io.bake`'s `image(i)`** taking `maxSize` and decoding in the CLI.
- **Stills shrunk before `share`.** The web player's viewer still decodes each still at full size
  in their browser before shrinking it. `share` could ship each still already shrunk, at the sizes
  a render asked for, keyed as in 6.

**How to reverse.**
- **The decoder.** It sits behind one call, `decode(bytes, maxSize)`. A JavaScript decoder could
  answer it again, with the filter's JS port; the bytes would change back, as noted in 3.
- **Where it runs.** Moving the decode back into each host means only routing `io.image` to the
  host's own copy of the module.
- **The cache.** Its entries are derived bytes: deleting `.shaderera/cache/` is always safe.
