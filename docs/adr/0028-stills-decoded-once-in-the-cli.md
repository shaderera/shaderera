# 0028: Stills decoded once in the CLI, at the size used, and cached

2026-10-27. Proposed (#453); the owner approved the direction, ADR first, and the maintainer
decided its open questions the same day (PR #457). Amends 0007 (parallel
export).

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

**Decision.**

1. **The CLI's process decodes a still, once for all hosts.**
   - `io.image` becomes a service request, like `video-open`. The Node host asks over IPC, the
     browser host's worker over the runner server.
   - The decode runs in a worker thread of the CLI, not on the thread that serves every host's
     video frames and cache. A 4 s JPEG must not stall a clip.
   - Several hosts asking for the same still at the same time share one decode. The CLI keeps
     the decoded still in memory while a host of the command that asked for it is open, as it
     keeps a clip's decoder (`shared`), and drops it when the last one closes.
   - The decoder stays fast-png and jpeg-js, in `runner/image.ts`. The web player has no CLI, so
     its worker answers `io.image` itself with the same module and the same filter
     (`player/services.ts`), from `files/`. It gets the same bytes as the CLI, as `io.bake` does
     today. This is why the decoder stays JavaScript (see Rejected).
   - `io.bake`'s `image(i)` is unchanged: it decodes in the host, at full size.

2. **`io.image(path, { maxSize })`: the still at the size the film draws it.**
   - `maxSize` is a whole number of pixels. The still's long side becomes at most `maxSize`, with
     the aspect kept: the long side is exactly `maxSize`, and the short side is
     `max(1, round(short × maxSize / long))`.
   - It only shrinks. A still already within `maxSize` comes back as it is, the same bytes as
     without the option. Without `maxSize`, `io.image` gives the full size, as today: no film's
     pixels change.
   - Bit depth is kept: a 16-bit PNG shrinks at 16 bits.
   - The film chooses the size: the largest it ever shows the still, in output pixels. A Ken
     Burns push to 1.3× on a 1920×1080 frame needs about 2500, not 1920. The engine does not
     guess it.

3. **One filter: area average (box), weighted by alpha, in the file's code values, in exact
   integer arithmetic.**
   - **How it works.** Each output pixel is the average of the source pixels under its footprint,
     each weighted by the area it covers. This is the filter of OpenCV's `INTER_AREA` and
     Pillow's `BOX`. Colour is weighted by alpha (premultiplied), and the result is straight
     again, so transparent pixels' hidden colour does not bleed into edges.
   - **Exact integer arithmetic.** It is separable: rows, then columns. The coverage weights are
     whole numbers (in units of 1/(source × output) pixel). Each pass rounds half up, once. The
     implementation fixes the passes and the rounding, and a test pins known bytes.
   - **Why a box.**
     - **Byte-identical everywhere.** It needs only integer adds, multiplies and divides. Those
       give the same result in every JavaScript engine: Node's V8, Chrome's worker, any
       browser playing a player.
       Lanczos and bicubic need `sin` or float weights. ECMAScript leaves `Math.sin` and
       `Math.pow` to the implementation's approximation, so a player in another browser could
       differ by a code.
     - **It only shrinks, and a box is the right shrink.** Every source pixel counts once, so
       fine detail averages instead of aliasing.
     - **No overshoot.** There are no negative lobes, so no ringing halos round a logo's edge and
       no clamping. Sharpening is a look, and the film's (0011).
     - **The same choice as the rest of the engine.** Like Canvas2D's smoothing, `image-fit`'s
       pyramid and a GPU's sampling of an `rgba8unorm` texture, it averages code values, not
       linear light. A still shrunk by `maxSize` looks like the full one drawn small.
   - **Fixed, not an option.** One filter is one set of bytes to test, and the cache key never
     has to name it. A film that wants another filter decodes at full size and shrinks it itself,
     or keeps it in `io.cache`.

4. **The cache key: the file's content hash, the decoded size and the decoder's version.**
   - The key is `sha256` of a fixed tag naming the decoder version, the file's sha256, and the
     decoded `width×height` (and bits).
   - **The content hash, not the path or the time.** A file edited in place, or a copy under
     another name, is keyed right. This is how `io.cache` keys its inputs, and how 0016 checks
     bakes. Hashing a 10 MB JPEG takes milliseconds against seconds of decoding.
   - **The decoded size, not `maxSize`.** On a 3000 px still, `maxSize` 4000 and 5000 give the
     same pixels, so they share one entry. Size is all that is needed, because the filter is
     fixed.
   - **The decoder's version.** The tag changes when fast-png, jpeg-js or the filter changes the
     bytes, so an upgrade makes new entries rather than serving old ones.
   - **The entry.** The decoded RGBA, raw, with its width, height and bits. Reading it back costs
     a file read, not a decode.

5. **The cache is sized by the decoded size, and keeps the 1 GiB cap.**
   - Entries live in `.shaderera/cache/` beside `io.cache`'s, under the same limit
     (`SHADERERA_FILM_CACHE_MB`), and are evicted the same way.
   - With `maxSize`, a still costs what it shows. At 2560 px it is 14.7 MB at 8 bits, so twenty
     fit in under 300 MB.
   - **Too big to keep.** An entry larger than one eighth of the limit (128 MiB at the default)
     is not written. It would push out up to eight others on every run. Such a still is decoded
     once a command, in the CLI, not once a host, which is still better than today.
   - **No warning of its own.** The warning for a still decoded far larger than the film shows it
     (the 8000×6000 photograph in a 1080p film) belongs to #454's lint for per-frame CPU pixel
     work. There is one warning, not two.

6. **GPU mips are deferred. `image-fit` keeps its CPU pyramid.**
   - `image-fit` is a Canvas2D plugin, and must run in a Node host without `webgpu` (0002, 0007).
     A GPU mip chain cannot replace it there.
   - WebGPU has no `generateMipmap`. A chain made by a render or compute pass samples with
     precision the spec leaves to the implementation. So Dawn in Node and Chrome on another
     adapter need not agree to the byte, and they do agree today.
   - With `maxSize`, the pyramid's cost falls with the pixels. A 2560×1440 still has about a
     thirteenth of an 8000×6000's, and the pyramid is built once in `open`.
   - A film on the GPU makes its own mips, as `render-three-textures` lets three.js do. A plugin
     that makes a mip chain on the device (one job, plain data in and out) comes when a film
     needs one, not before.

**What changes in `docs/protocol.md`.**
- `Io.image` becomes `image?(path: string, options?: { maxSize?: number }): Promise<DecodedImage>`,
  in the type block and in `packages/core/src/protocol.ts`.
- The `io.image` bullet now says:
  - the CLI's process decodes the still, once a command for every host, in a thread of its own;
  - `maxSize` and its rounding;
  - the filter, by name;
  - the cache entry, its key, and the one-eighth rule;
  - that the web player's worker decodes with the same code, the same bytes.

  It drops "once per file in a host".
- The `io.cache` bullet says the cache also holds decoded stills, under the same limit.
- The bullet on what runs in the CLI's process ("Project code cannot write files…") adds the image
  decoder.
- `docs/player.md` adds an `io.image` line: decoded in the worker from `files/`, the same bytes as
  the CLI.
- `docs/authoring.md` (the table row for images) says to pass `maxSize`: the largest size the
  film shows the still.

**What amends 0007.** Decision 3 (parallel export) now shares a still's decode between the N
hosts, as one decoder of a clip already serves them. N hosts no longer cost N decodes of every
still, and the hosts still agree, because they receive the same bytes. 0007's GPU compositing
and its uploads are unchanged: an `io.image` is still CPU bytes that a layer uploads once.

**Rejected.**
- **ffmpeg or sharp (libvips) in the CLI.** Both are much faster. libvips can also shrink a JPEG
  while decoding it, in the DCT. But the web player cannot run either, so a shared film would
  show other bytes. ffmpeg would also become a requirement for films with stills and no footage,
  and libvips's bytes change with its versions. The cache already pays a slow decode once per
  file per machine.
- **A default `maxSize`** (the output size, say). It would silently change existing films'
  pixels, and it would guess wrong for any still that is zoomed.
- **Lanczos or bicubic.** See 3.
- **Linear-light averaging.** It is closer to how light adds, but it disagrees with every other
  shrink in the engine and needs `pow` or a table per bit depth. The filter averages code values
  (maintainer, 2026-10-27).
- **Caching every decode whatever its size.** One 384 MB 16-bit still would push out most of a
  film's cache on every run.

**Later, if a film needs it** (out of scope here; maintainer, 2026-10-27).
- **`io.bake`'s `image(i)`** taking `maxSize` and decoding in the CLI.
- **Stills shrunk before `share`.** The web player's viewer still decodes each still at full size
  in their browser before shrinking it. `share` could ship each still already shrunk, at the sizes
  a render asked for, keyed as in 4.

**How to reverse.** `maxSize` is optional and the full-size decode is unchanged, so moving the
decode back into each host means only routing `io.image` to `runner/image.ts` again. The cache
entries are derived bytes: deleting `.shaderera/cache/` is always safe.
