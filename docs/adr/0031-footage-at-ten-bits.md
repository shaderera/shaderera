# 0031: Footage at 10 bits, as Y'CbCr planes a film asks for, converted by core to half float

2026-10-31. Accepted (#574, part of #568). The owner decided its open questions as proposed
(owner: "agree all"); nothing is implemented yet. Amends [0027](0027-video-frames-as-ycbcr.md) (its deferred `yuv420p10`) and the
`Io` contract (`Footage`). #575 (footage declares its colour space) builds on it.

**Context.** Footage reaches a film at 8 bits whatever the file holds:
- `frame(i)` is 8-bit RGBA (`decoder.ts`: `scale=…:out_range=full,format=rgba`), and
  `frame(i, { format: 'yuv420p' })` reduces a 10- or 12-bit file to 8 bits (0027, decided).
- The web player's proxy is H.264 `yuv420p`, and its `i420` refuses a sample of more than
  8 bits (`player/media.ts`, `player/services.ts`).
- The grading plugins (`color-lut`, `color-primary`, `color-spaces`, `color-curves`,
  `color-qualifier`) are WGSL functions on a float colour, and `analysis-scopes` already reads
  16-bit frames. `io.image` already gives 16 bits for a 16-bit PNG. Only footage is short.
- Phones record 10-bit HEVC by default, and every camera's log mode is 10 bits or more.

**Measured** (2026-10-31, i5-14400F, Windows 11, ffmpeg 9.0.2, Node 24.14; the scripts and
clips are throwaway, in the session's scratch folder).

*Banding.* A 1920-pixel grey ramp, 10-bit BT.709 limited (Y 64–940, 877 levels, FFV1 so the
codes are exact), decoded as today (`rgba`, 8 bits) and as `rgba64le` (16 bits). Then a grade
of ±1.5 stops in linear light (sRGB curve off and on again), quantised to the delivery's bits:

| grade, delivery | 8-bit decode: levels, largest step | 8-bit + ±1 LSB dither | 16-bit decode |
|---|---|---|---|
| source | 256 | | 877 |
| +1.5 stops, 8-bit | 160 levels, steps of 3 codes | 252, steps up to 5 (noise) | 254, every step 1 |
| +1.5 stops, 10-bit | 160, steps of 12 | 715, steps up to 15 | 552, steps up to 4 |
| −1.5 stops, 8-bit | 160, steps of 1 | 160, steps up to 2 | 160, steps of 1 |
| −1.5 stops, 10-bit (`hdr10`) | 255, steps of 3 | 628, steps up to 6 | 641, steps of 1 |

- Lifting 8-bit footage by 1.5 stops leaves 94 of the 254 codes empty: bands three codes apart,
  in the shadows where the eye sees them most. From the 10-bit file every code is used.
- Into a 10-bit delivery (0023's HDR10) the 8-bit decode is the limit, darkening or lifting.

*Camera log.* Sony's S-Log3 puts black at 10-bit code 95, 18 % grey at 420 and 90 % white at
598, and each stop above grey at 261.5 × log10 2 ≈ 79 codes. At 8 bits that is about 20 codes a
stop. A Rec.709 display puts the stop above mid grey at 44 8-bit codes (118 to 162). So 8-bit
S-Log3 shown at normal contrast has every other code missing before any grade. That is the
"range lost" the issue names, and no dither brings it back.

*Size and decoding.* A 10-bit 4:2:0 HEVC clip (`testsrc2`, 60 frames), decoded by ffmpeg with
`-threads 4` into a pipe that Node reads, best of 3 (ms a frame):

| format | bytes a pixel | 1080p frame | 2160p frame | ffmpeg ms, 1080p / 2160p |
|---|---|---|---|---|
| `rgba` (today) | 4 | 8.3 MB | 33.2 MB | 7.8 / 26.7 |
| `yuv420p` (0027) | 1.5 | 3.1 MB | 12.4 MB | 5.4 / 16.8 |
| `yuv420p10le` (option b) | 3 | 6.2 MB | 24.9 MB | 5.6 / 18.2 |
| `rgba64le` (16-bit integers) | 8 | 16.6 MB | 66.4 MB | 12.4 / 40.2 |
| `rgba16float` (option a) | 8 | 16.6 MB | 66.4 MB | 12.4 / 40.2, then +22 / +78 in JS |

- ffmpeg 9.0.2's swscale reads `rgbaf16` but cannot write it. Half-float frames are `rgba64le`
  converted after ffmpeg: one thread of JavaScript took 22 ms at 1080p and 78 ms at 2160p.
- A 10-bit file into `yuv420p10le` passes through: decoding only, 0.2 ms over 8-bit planes.
- **The hop** to the host costs by the byte (0030). Fitted to 0030's *fetch* rows (RGBA and
  `yuv420p`, one host 27.5 and 16.3 ms, four hosts 76.7 and 47.3 ms), `yuv420p10` would wait
  about 23 / 65 ms and 16-bit RGBA about 45 / 124 ms. That is an extrapolation, not measured.
- **On the GPU** a held frame is 8 bytes a pixel either way once it is half float: 16.6 MB at
  1080p, 66.4 MB at 2160p. Option (b) adds its three `r16uint` planes, 6.2 / 24.9 MB.

**The options.**

- **(a) `rgba16float` frames.** `frame(i, { format: 'rgba16f' })` gives half-float RGBA.
  - Cost: 2× today's RGBA and 2.7× option (b) on every hop. ffmpeg's conversion plus a
    JavaScript pass per frame (34 ms at 1080p), or 16-bit integers the film converts itself.
  - Touches: the decoder's arguments and a conversion in the CLI, the bulk pipe and runner server
    (twice the bytes), `AHEAD_BYTES`' frame size, the web player (a 10-bit proxy, and converting
    WebCodecs' planes to RGBA in JavaScript), `check` and `render` (bytes only).
  - What it gives: a frame any code can read, CPU or GPU, with no shader of core's.
- **(b) 10-bit Y'CbCr planes, 0027 extended, converted on the GPU.**
  `frame(i, { format: 'yuv420p10' })`.
  - Cost: 6.2 MB at 1080p, under today's RGBA. ffmpeg converts nothing for a 10-bit 4:2:0 file.
  - Touches: one more format in the decoder's arguments, `frameBytes` and `AHEAD_BYTES`
    (nothing in the pipe or runner server, which carry bytes as they are), `videoTexture` (a
    16-bit output), the web player (as below), and `check` and `render` (bytes only).
  - What it gives: the file's own codes, superwhites included, which a log curve (#575, #589)
    needs as they are. Only a film with a GPU, or one that converts planes itself, can use it.
- **(c) Keep 8 bits and dither.** A dither before the grade fills the empty codes with noise
  (252 of 254 levels, steps up to 5 codes).
  - Cost: nothing in the engine; a dither function in a plugin.
  - Touches: nothing.
  - What it gives: bands turned to grain. It cannot give back what the 8-bit decode dropped: log
    footage keeps its 20 codes a stop. A grain is a look, which 0011 leaves to the author.

**Decision.** Option (b), asked for by the film per call, as 0027's formats are.

1. **`frame(i, { format: 'yuv420p10' })`.**
   - **The layout.** 0027's I420 with 16-bit little-endian samples holding 10-bit values in
     their low bits, as ffmpeg's `yuv420p10le` and WebCodecs' `I420P10` are. Length
     `2 × (width × height + 2 × cw × ch)`: 6 220 800 at 1920×1080. It resolves to a
     `Uint16Array` over those bytes, as `io.image` gives 16 bits. A film uploads each plane to an
     `r16uint` texture.
   - **Not 0027's P010.** 0027 named P010's layout for this. P010 is semi-planar (CbCr
     interleaved), which 0027 rejected as NV12 for the 8-bit planes, and neither ffmpeg's
     planar output nor WebCodecs gives it without a shuffle.
   - **What ffmpeg does.** It keeps the file's matrix and range, as 0027 does, and changes only
     the pixel format. A 10-bit 4:2:0 file passes through. A 12-bit file is reduced to 10, a
     4:2:2 or 4:4:4 file subsampled (0027's `chroma` rule), an 8-bit file shifted up by two
     bits (exact). A clip with alpha refuses it, naming `rgba`.
   - **`Footage.bits`** (`8 | 10 | 12 | 16`): the file's sample depth, read from the probe's
     `pix_fmt`, so a film or plugin chooses, and `check` (#575) knows a 10-bit source.
2. **`videoTexture(device, clip, { bits: 10 })`** converts the planes into an `rgba16float`
   texture, by `clip.colour` and 0027's chroma rules.
   - **Exact in every host.** It computes in `i32` as 0027 does, rounds to an integer `k` in
     −2048…2047 and stores `k / 1024`. Every multiple of 1/1024 under 2 in magnitude is exact in
     half float, so no implementation rounds the store its own way. The TypeScript reference
     (`yuv420p10ToRgba`) and the same byte-for-byte tests as 0027 hold it.
   - **Code values, not light.** The output is R'G'B' code values, 0–1 for the nominal range,
     with superwhites and out-of-gamut values kept past 0 and 1 (only the corners of the code range
     pass ±2 and clamp). It applies no transfer curve.
     Turning S-Log3 or LogC codes into light is `color-spaces`' job once #575 says what the file
     is. The engine converts nothing on its own.
3. **When a film gets it: when its code asks, per footage file.** No manifest field, no switch
   for 10-bit sources.
   - Doing it always for >8-bit sources would change the pixels of every existing film that
     uses phone footage, and double its hop, for films that never grade.
   - `frame(i)` and `{ format: 'yuv420p' }` stay byte for byte as they are.
4. **The web player** answers `yuv420p10` from its 8-bit proxy, shifted up two bits, so a shared
   film runs and gives the same shapes. It bands where the original would not, and docs/player.md
   says so. A 10-bit proxy (AV1 10-bit, which Chrome decodes in software on every system, and
   which decodes exactly by the standard) is not built now.

**Decided by the owner.**
- (b) over (a): (a) is simpler for CPU code, (b) is 2.7× smaller and is what #575 needs.
- Per call, not always for >8-bit sources.
- The web player shifts its 8-bit proxy. A 10-bit AV1 proxy (a slower encode on share and a
  second proxy codec) is not built now.

**Consequences.**
- **#575 builds on it.** A film declares a file's space where it opens it
  (`io.video(path, { transfer, gamut })`), and the frame carries it beside `colour`. A film reads
  `yuv420p10` through `videoTexture` and hands the codes to `color-spaces`. `check` warns when
  `bits > 8` and no space is declared, or when such a file is read only as 8-bit. #589's camera
  curves then take the codes this ADR keeps.
- **0023 is unchanged.** `videoTexture`'s output is code values, not light. PQ and HLG footage
  into an `hdr10` render needs a light declaration, which is #575's or later.
- **0030 is unchanged.** A `yuv420p10` frame rides its pipe or ring like any other bytes, and
  costs less than RGBA there.
- **analysis-scopes** reads a footage frame through `yuv420p10ToRgba`'s output, at 16 bits.
- Films that do not ask see no change.

**Rejected.**
- **(a) as the format.** 2.7× (b)'s bytes on a hop that already bounds footage (0030), and a
  JavaScript conversion per frame, since swscale cannot write half floats.
- **(c) as the answer.** It hides bands as grain and cannot give log footage its codes back.
- **Always 10 bits for >8-bit sources.** It changes existing films' pixels and costs.
- **`rgba32float` output**, which needs no exactness trick: twice the GPU memory of half float
  for no precision a 10-bit file has.

**Verify before implementation.**
- That swscale's `yuv420p10le` output of a 10-bit 4:2:0 file is the decoder's own samples (md5
  against `-f rawvideo` with no filter), and its 12→10 and 8→10 rules.
- `videoMs` of #434's *fetch* film in `yuv420p10` at 1080p and 2160p, one and four hosts, beside
  0030's numbers, to replace the extrapolation above.

**How to reverse.** Everything is behind the `yuv420p10` format and `videoTexture`'s option.
Removing them leaves today's formats as they are.
