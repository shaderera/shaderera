# 0023: HDR10 delivery, with the film's own tone mapping

2026-10-22. Proposed; waiting for the owner's approval (#295). No code until it is approved.

**Context.** Shaderera delivers SDR only. The host composites sRGB code values in a half-float
accumulator clamped to 1.0. A host with a GPU hands ffmpeg 8-bit `yuv420p` (BT.709) for an mp4
and 16-bit RGBA for ProRes ([0007](0007-gpu-first-host.md), [0012](0012-delivery-and-agent-tooling.md)).
0012 left HDR "until a customer needs it". YouTube, Apple and the TV platforms take HDR10, and
films made in shaders already compute more light than SDR can show: `render-three-host` renders
into a linear half-float target and then tone-maps it down to sRGB.

The standards and tools, as read on 2026-10-22:
- **PQ**: SMPTE ST 2084:2014, constants also in ITU-R BT.2100-3 (02/2025) Table 4; 1.0 is
  10 000 cd/m². **BT.2100**: BT.2020 primaries; non-constant luminance (Kr 0.2627, Kb 0.0593);
  10-bit narrow range Y 64–940, C 64–960; Table 8 sites 4:2:0 chroma co-sited with the top-left
  luma sample; Table 10's FP16 linear form has 1.0 = 203 cd/m².
- **BT.2408-9** (03/2026) §9: SDR graphics go to "Graphics White", 203 cd/m² (58% PQ, code 573),
  by a display-light mapping where a brand's colours must hold.
- **CTA-861.3**: MaxCLL is the brightest `max(R,G,B)` of any pixel, MaxFALL the highest frame
  average of it, in cd/m²; SMPTE ST 2086 describes the mastering display.
- **YouTube** (answer 7126552): PQ or HLG, 10 or 12 bits, BT.2020 primaries and matrix, in MP4,
  MOV or MKV; HEVC, VP9 Profile 2 or AV1 (ProRes at high rates). Without ST 2086 and
  MaxCLL/MaxFALL it assumes a Sony BVM-X300. It makes the SDR version itself, or from a `.cube` LUT.
- **Apple** (HLS authoring spec): HEVC Main 10 as `hvc1`, the mastering and light-level SEI
  present, and SDR streams beside HDR ones.
- **ffmpeg** (source and docs at tag `n9.0`, 2026-08-03; 9.0.2 is current): libx265 writes
  both SEI, from `-x265-params` or from side data; `hevc_nvenc` only from side data (8.0+, NVENC SDK 13); `hevc_videotoolbox`
  writes neither. The mp4/mov muxer writes `mdcv`/`clli` only from side data, and tags HEVC
  `hev1` unless told. 9.0 added the per-stream input options `-mastering_display` and
  `-content_light` (`doc/ffmpeg.texi`; absent in 8.1) to set that side data.
- **WebGPU** (CRD 2026-09-15): `rgba16float` renders and stores on a core device. Chrome 129+
  shows light above 1.0 on an `rgba16float` canvas with `toneMapping: 'extended'`; no BT.2100
  canvas colour space exists.

Prior art: webgl2video (MIT, d8ec4fc). Its page draws PQ code values of BT.2020 RGB, applies a
seeded TPDF dither (±1 LSB, none on black), quantises to 10 bits, then makes P010 on the GPU from
those codes (chroma sited left, unlike BT.2100's top-left) and meters MaxCLL/MaxFALL
in two reductions. `exact.py` holds that P010 to a float64 reference: no sample off by more than
one code, under 0.01% off by one, levels equal. `hdr.py` keeps each segment's levels and writes
the metadata once every frame is known.

**Decision.**

1. **Where precision rises: a film opts in, and its layers say what light they carry.**
   - **The opt-in.** The manifest's `hdr10` block. A default is given only where a standard
     names the value; a standard's value is not taste (this refines 0011's test).
     - `graphicsWhite`, in cd/m². Default 203, BT.2408's Graphics White.
     - The mastering display (`peak` and `min` in cd/m², and primaries). Required: ST 2086
       defines how to describe one but names none, and it states which monitor the film was
       graded on, which only the person knows. The docs mention the common P3-D65 1000 cd/m².
     - `dither: 'tpdf' | 'none'`. Required: no standard names a dither for 10-bit PQ.

     A job asks for `range: 'hdr10'` (`--hdr10`), and the source reads `host.range`.
   - **What a layer may carry.** A `GPUTexture` layer of `host.gpu` may declare
     `light: { transfer: 'linear' | 'pq', primaries: 'bt709' | 'bt2020' }`. The texture is
     `rgba16float` or `rgba32float`.
     - Linear is BT.2100's FP16 scale: 1.0 is 203 cd/m², whatever `graphicsWhite` is.
     - PQ is code values from 0 to 1.
   - **Layers that stay SDR.** Every other layer stays 8-bit or float SDR in sRGB code values:
     canvases, bytes, DOM snapshots, `io.image`, `io.video`, and every existing plugin's output.
     In an HDR frame such a layer is decoded with the sRGB curve and taken from BT.709 to BT.2020
     primaries. Its white is then placed at `graphicsWhite` (BT.2408's display-light mapping).
   - **The HDR compositor.** It runs `over` premultiplied in linear BT.2020 light, in an f32
     accumulator (16 bytes a pixel; 133 MB at 2160p). Then it clamps negatives to 0 and encodes
     PQ. It quantises to 10-bit R'G'B' codes, dithered only if declared, with the seed from the
     frame index. Y'CbCr is made from those codes.
   - **Nothing is clipped at the peak.** A frame whose light passes the declared peak fails
     `check` and the render, naming the frame and the cd/m². Clipping it would be a look, and
     metadata below the content is a lie.
   - **Hosts.** An HDR render needs a `GPUDevice` in every host. The Node host's Skia path
     refuses it.

2. **Tone mapping is the film's, and so is its SDR version.** The engine takes linear or PQ
   light in a declared space and has no curve: no house tone map, no SDR derived from the HDR
   master.
   - **The SDR version is a second render** of the same job with `range: 'sdr'`. The film's code
     maps its own light down, with its own code or a plugin the person adds (`look-tonemap`).
   - **An SDR render refuses HDR layers.** A linear or PQ layer in an SDR render is an error, not
     a silent clamp.
   - **YouTube's SDR LUT.** A person may still upload a `.cube` LUT through YouTube's metadata
     tool; an mp4 cannot carry one. Shaderera does not make LUTs.

3. **Delivery: an HDR10 master is HEVC Main 10 in an mp4.** HEVC is allowed (owner, 2026-10-22):
   Shaderera ships no encoder and drives the person's own ffmpeg. HEVC comes first.
   - **The stream.**
     - Codec and format: `hvc1`, `yuv420p10le` from P010, narrow range.
     - Tags: `bt2020`, `smpte2084`, `bt2020nc`, and chroma location `topleft` (BT.2100
       Table 8; `-chroma_sample_location topleft`, which libx265 writes as VUI type 2).
     - Metadata in both places, the SEI in the stream and the mp4's `mdcv` and `clli` boxes:
       - the declared ST 2086 mastering display;
       - MaxCLL and MaxFALL, measured on the GPU from the 10-bit codes.
   - **Measuring before the encode.** The levels are known only after the last frame, so every
     HDR10 encode goes through the lossless chunks that `plan` and `assemble` already use.
     - Hosts write P010 frames to FFV1 `yuv420p10le` chunks, and each chunk records its levels.
     - The encode then runs once, with ffmpeg 9.0's `-mastering_display` and `-content_light`
       on the chunks' input.
     - A plain `render` is a one-chunk plan.
   - **Encoders.**
     - **x265** for a master, always (as 0007 keeps x264 for SDR masters), with `hdr10-opt` and
       `repeat-headers`.
     - **`hevc_nvenc`** for a review, where ffmpeg is 8.0 or later with SDK 13.
     - **`hevc_videotoolbox`** for a review only, because it writes no metadata.
   - **ffmpeg 9.0 is required only when a film turns on `hdr10`.** SDR stays tested on 8.1.1.
     `doctor` reports the ffmpeg version and says HDR needs 9.0.
   - **ProRes.** `prores-hq` and `prores-4444` take the same PQ R'G'B' at 16 bits, tagged the
     same, with the boxes in the mov. That conversion is ffmpeg's, so the exactness test does
     not cover it.
   - **The probe.** `deliver` and every probe read back:
     - profile Main 10, pixel format and range;
     - the four colour tags and the `hvc1` tag;
     - the boxes and the first frame's SEI. These must equal the declared display and the
       measured levels, to within the units of each field.
   - **Placements.** A placement may declare `transfer`, `bitDepth` and `hdrMetadata`.
     `format-placement-specs` gains YouTube HDR, with its source.
   - **`check`.** It hashes the P010 bytes for determinism, and checks the peak and the layers'
     declarations.

4. **Exactness.** The GPU conversion from 10-bit R'G'B' codes to P010 must match a float64
   reference.
   - **The reference** is written in TypeScript (JS numbers are float64):
     - BT.2020 non-constant luminance, narrow range, 4:2:0;
     - chroma sited top-left (BT.2100 Table 8, `chroma_sample_loc_type` 2, tagged): each chroma
       sample at an even column and even row, the [1 2 1]/4 filter across and the [1 2 1]/4
       filter down around it, edges clamped;
     - the light levels from the same codes.
   - **The test** composites a fixture frame twice on Dawn: once as 10-bit R'G'B' codes and once
     as P010 with its levels. The fixture holds:
     - ramps across all 1024 codes;
     - BT.2020 primaries at the peak;
     - hard colour edges;
     - near-black;
     - an 8-bit graphics layer at `graphicsWhite`.
   - **Passing** means no sample off by more than one code, under 0.01% off by one, the top code
     equal and MaxFALL within 1e-4. It runs in core's GPU tests, and in the browser host's
     contract test.

5. **Existing films and plugins do not change.** Without `hdr10` in the manifest, every path,
   pixel format, tag and hash stays as it is today, and the SDR `yuv420p` pass is untouched.
   - No plugin changes to opt in.
   - `render-three-host` could later hand its linear target as a linear layer, when a film asks.

**The 8-bit SDR assumptions this implies changing** (paths as of `c1c3539`):
- `packages/core/src/compositor.ts`:
  - :97 clamps the accumulator to 1.0.
  - :42, :59, :98 and :199 hold a packed half-float accumulator.
  - :26 has only `rgba | rgba64 | yuv420p` outputs.
  - :130–138 use BT.709 at 8 bits.
  - :264 uploads every byte layer as `rgba8unorm`.
- `packages/core/src/protocol.ts`:
  - :316–325: a `Layer` has no declared light.
  - :164–171: `io.image` and `io.video` are sRGB.
  - :202: `bits: 8 | 16` only.
- `apps/cli/src/cli/ffmpeg.ts`:
  - :52–67: `SDR_BT709` is the only tag set.
  - :79 and :174: `Input` has no P010.
  - :171–201: H.264 or ProRes only.
  - :340–405: `probe` reads no side data, codec tag or chroma location.
- `apps/cli/src/cli/render.ts:198–206` picks `yuv420p` or `rgba64`, and :288 records 8 or
  16 bits.
- `apps/cli/src/deliver/chunks.ts:60–80` maps FFV1 and raw formats, and :159–161 checks the
  formats a host has.
- `apps/cli/src/node/child.ts:107–147`: `has.yuv` and `has.deep` only.
- `apps/cli/src/cli/preroll.ts:17–23` makes black and slate frames in `yuv420p` or `rgba64`.
- `apps/cli/src/deliver/placement.ts:20–40` has no transfer, bit depth or HDR metadata.
- `apps/cli/src/deliver/finishing.ts:19` states the colour as "8-bit sRGB … BT.709 primaries".
- `apps/cli/src/deliver/png.ts:13`, :51 writes an `sRGB` chunk only. A PQ still would need
  PNG Third Edition's `cICP`.
- `apps/cli/src/node/services.ts:88` decodes footage to 8-bit full-range RGBA. PQ footage would
  arrive as wrong sRGB codes.
- `apps/cli/src/runner/dom.ts:90`, :236: DOM capture is 8-bit sRGB (it stays an SDR layer).
- `apps/cli/src/review/measure.ts:26–38`: review's luma, clip (≥ 250) and crush thresholds are
  on 8-bit BT.709.
- `apps/cli/src/node/fixtures/memory-child.ts:136–182` has the CPU `yuv420p` and `rgba64`
  references.
- `docs/delivery.md`: "The mp4: tested SDR BT.709" and "Higher precision" (its HEVC sentence is
  updated with this decision).

Stills and review stay SDR. An agent looks at the film's SDR render, and reads the HDR as numbers
(MaxCLL, MaxFALL, the share of pixels above `graphicsWhite`). A PQ image shown as sRGB would
mislead it.

**Rejected.**
- A house tone map, or an SDR version derived from the HDR master: either one decides the look (0011).
- Compositing in PQ code values: `over` would follow PQ's curve, not light.
- Decoding SDR layers with BT.1886 (gamma 2.4), as BT.2408 maps SDR: the author previews them as sRGB.
- Clipping at the mastering peak: a look made silently.
- Two renders, one to meter and one to encode: twice the source's cost. The lossless chunks already exist.
- Patching the metadata into the file afterwards (webgl2video's MKV route): MKV only, and a second tool (MKVToolNix).
- HLG: YouTube and Apple take HDR10; HLG is broadcast's. It can come with a customer.
- AV1 10-bit: deferred until a user asks; YouTube takes it, Apple's HDR is HEVC.
- Chroma sited left (H.264/HEVC's default when untagged, and webgl2video's): BT.2100 sites it top-left.

**Verify before implementation.**
- CTA-861.3 Annex A's normative MaxCLL/MaxFALL formula (paywalled; the definition here is
  from secondary sources).
- Whether ffmpeg 9.0's `-mastering_display` and `-content_light` apply to a raw pipe input. If
  not, a stream-copy remux of the encoded file with those options on its input writes them.
- Whether VideoToolbox inserts the HDR metadata itself (ffmpeg sets none).

**How to reverse.** Everything sits behind the manifest's `hdr10` and `range: 'hdr10'`.
Removing them leaves the SDR paths as they are.
