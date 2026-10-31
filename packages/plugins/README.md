# Plugins

The official Shaderera plugins (decision 0008), one folder each, MIT. Each folder is what
`shaderera publish` reads: a `shaderera.item.json` label, a `README.md` that
`info` prints, and the files `add` copies into a project at the same paths.

Each folder also has a `preview/`: the plugin's preview for the website (`preview.json` and an
`index.ts` in the house style). It is never in `files`, so `add` and `publish` leave it out.
`previews/` is the harness that renders them (see its [README](previews/README.md)).
[docs/plugin-guide.md](../../docs/plugin-guide.md) says how to write a new plugin and its
preview, and [CONTRIBUTING.md](../../CONTRIBUTING.md) how to send it.

They come from films that were made and accepted. Each one was made generic: no film's numbers,
its options as parameters, defaults that render well. Once added, a plugin is the project's own
code, to change freely.

Plugins are named `<category>-<thing>`, so related ones sort together and the name says what it
is: `analysis`, `asset`, `audio`, `camera`, `color`, `font`, `format`, `image`, `look`, `motion`, `render`, `review`,
`text`.

| Plugin | Type | What it does | From |
|---|---|---|---|
| `analysis-scopes` | component | a frame as scope numbers: levels, black and white points, % clipped and crushed per channel, histogram, waveform and RGB parade by column band, balance in shadows, midtones and highlights, a vectorscope summary with skin tones against the skin-tone line; no scope images | #568: films came out dark, and an agent cannot grade what it cannot measure |
| `asset-provenance` | component | where each outside file came from: a record per file (source, licence, author, segment, sha256), the ASSETS.md table and the description's credits | an in-house explainer film, 2026-10-16 |
| `audio-beat-clock` | component | measure a song (tempo fitted to its onsets, bars, onsets, bands); a clock, band levels and hits at render time | opening film; tempo fit from later in-house films |
| `audio-hall-ending` | component | an ending that rings out in a hall and dies to silence (ffmpeg) | opening film |
| `audio-listen` | component | hear a recording with CLAP (transformers.js, on the CPU) and keep the takes that match a description as trims stamped to its bytes, each with its peak, so a clip lands on a hit point | decision 0018, before a film (experimental) |
| `audio-voice-repace` | component | re-pace a narration (long pauses between words shortened, named ones kept, tempo with the pitch kept, ffmpeg) and a time map the edit's times follow | an in-house narrated film, its paced voice |
| `camera-ken-burns` | component | the crop of a still a frame shows: framed on a box with headroom, moved between two framings at an even speed (scale in log space), kept inside the picture | an explainer film on cats in art (POC), 2026-10-15 |
| `camera-keyframes` | component | a 3D camera as shots: orbit, dolly, crane, cut, exact framing, lenses in mm, shift, focus; WebGPU or three.js; core's camera contract; the lens rule for tall frames | opening film, ideas from camera-controls and Cinemachine |
| `camera-shake` | component | breathe, handheld, impact: seeded noise as a formula of t, scaled by an envelope | ideas from drei CameraShake |
| `color-cdl-files` | component | ASC CDL files (.cc, .ccc, .cdl) read into slope, offset, power and saturation per correction, as color-primary's cdl takes them, and written back; a small scanner, no XML dependency | #568: a grade from Resolve or on set in, and out to a colourist |
| `color-curves` | component | grading curves from control points: a master and R, G, B curves baked into a color-lut 1D LUT, hue vs saturation and hue vs hue around 360°; a monotone cubic (PCHIP-style) that never overshoots; WGSL and CPU with the same values, every default identity | #568: curves from points the person or the agent gives |
| `color-lut` | component | a .cube LUT (1D or 3D) read, applied and written: tetrahedral in WGSL from a 3D texture and on the CPU with the same values; the LUT's spaces are its author's, none ship | #568: a person's own grade in and out of Shaderera |
| `color-qualifier` | component | a hue, saturation and luma key to a soft 0–1 matte: ranges with their own smoothstep softness, hue wrapping at 360° and read as color-curves reads it, each range left out passing everything; WGSL and CPU with the same values; no shrink/grow | #568: a grade on one colour only (sky, skin, a product) |
| `color-primary` | component | primary grading as numbers: the ASC CDL v1.2 (slope, offset, power, saturation, clamped as the spec does), exposure in stops, contrast around a pivot, white balance by Bradford from a Kelvin or xy white; WGSL and CPU with the same values, every default identity on 0–1 | #568: the balance pass every grade starts with |
| `color-spaces` | component | a log working space and wide gamuts: ACEScct and ACEScc both ways, BT.1886, the camera logs (S-Log3, LogC3, LogC4, V-Log, Canon Log 3), and 3×3 matrices between Rec.709, Rec.2020, P3-D65, ACES AP0 and AP1 and the camera gamuts through XYZ, with Bradford when the whites differ; WGSL and CPU with the same values | #568: a CDL graded on log values, and wide gamuts |
| `font-ibm-plex-mono` | media | IBM Plex Mono, OFL | opening film |
| `font-ibm-plex-sans` | media | IBM Plex Sans, OFL | an in-house film |
| `font-instrument-serif` | media | Instrument Serif, OFL | an in-house film |
| `font-stix-two-text` | media | STIX Two Text, OFL | opening film |
| `format-broadcast-slate` | component | a clock slate for a broadcast preroll: the spot's details and a countdown, at negative t | research for 0.1.0 |
| `format-placement-specs` | preset | what Reels ads, YouTube (SDR and HDR), Amazon CTV, EU and US broadcast loudness and a DOOH screen accept, as requirements.json placements deliver checks the file against; each with its source and the date read | research for 0.1.0 |
| `format-safe-areas` | component | where text may go per format and platform, and the corner free for a credit | opening film |
| `image-fit` | component | a still placed into a rectangle of a Canvas2D frame: a decoded image or footage frame onto a canvas, cover (with a focal point) and contain, halved copies that draw it small the same every time | five in-house films that each wrote it inline, 2026-10-21 |
| `image-regions` | component | named regions of a photograph (mask, box, centre, the region that holds each) as analysis data; SAM 3.1 from words, or painted masks | a collage POC, 2026-10-14 |
| `image-to-png` | component | WebP, AVIF, GIF and a video's frames converted to PNG once, beside the originals, pixels kept (ffmpeg) | split from `render-three-textures` |
| `look-blur` | component | blur one frame, Gaussian, bokeh, directional or radial, by an amount from shapes, a map or depth: a sharp window, tilt-shift, depth of field | research: a poster's sharp window in a blurred world |
| `look-film-grain` | component | film grain: Gaussian, sized, strongest in the mid-tones, mono or colour | split from `look-screen-passes` (0.2.0) |
| `look-paper-edges` | component | a print on paper: cut out along any shape with a paper border, or a strip cut straight or torn, with white core and fibre | a collage POC, 2026-10-14 |
| `look-row-glitch` | component | bands of rows thrown sideways, and a real pixel sort of runs of light, along rows or columns | split from `look-screen-passes` (0.2.0) |
| `look-screen-passes` | component | the frame in another medium: ascii, halftone, dither, heat, contours, pixels, inverse; ink, paper, cell and palette as parameters | opening film |
| `look-tonemap` | component | linear light to display-referred colour through Khronos PBR Neutral or AgX, as WGSL functions and a CPU version with the same values | the Wallloom opening film's output shader |
| `look-vignette` | component | the edges towards black or a colour, in linear light, round, the frame's shape or a given ellipse | split from `look-screen-passes` (0.2.0) |
| `motion-eases` | component | a 0–1 progress shaped: eases (a stateless spring, bezier), clamp, lerp, progress through a span, one envelope over hit times | split from `motion-keyframes`, `audio-beat-clock` and `camera-shake` |
| `motion-keyframes` | component | values over time held between keys and eased into each, paths that flow through points | opening film |
| `motion-random` | component | deterministic random numbers from a seed: a PCG hash of an integer, the same hash in WGSL (checked bit for bit on the GPU), and a seeded mulberry32 stream | seven films' mulberry32 and the PCG hash copied in `text-scramble`, `text-glyph-points` and `camera-shake` |
| `motion-shot-list` | component | film time to shots: the shot or two on screen at t, local time and progress, the transition's progress, the source frame (floored, speed, freeze, reverse, exact at NTSC rates) and when each footage may be closed; draws nothing | five films' shot lists (taste-to-plugins, Wallloom opening, P(DOOM), zoom, procedural) |
| `render-bvh` | component | ray queries against triangles on the GPU: a binned SAH tree from positions and indices, WGSL closest-hit and any-hit; no shading | the Wallloom opening film's path tracer, its traversal only |
| `render-canvas-texture` | component | a Canvas2D canvas, or RGBA bytes, uploaded into a GPU texture of host.gpu for a WGSL pass, one texture per size reused; rgba8unorm, no colour conversion | the QA film's grain pass; replaced private copies in the five `look-*` passes |
| `render-gaussian-splats` | component | 3D Gaussian splats (.splat, .ply) rendered on host.gpu with a deterministic depth sort, as a premultiplied layer | research for 0.1.0 |
| `render-gltf-read` | component | glTF 2.0 (.gltf + .bin, or .glb) read into plain data: each primitive's typed arrays, its node's world matrix, its material as stated; refuses Draco and other required extensions by name | the Wallloom opening film, which wrote it twice |
| `render-srgb` | component | the sRGB transfer functions (IEC 61966-2-1), display values to linear light and back, in WGSL and on the CPU with the same values | written in seven films; replaced private copies in `look-blur` and `look-vignette` |
| `render-three-host` | component | three.js WebGPURenderer on host.gpu, deterministic, the frame as a GPU texture layer | product-studio's plumbing (no look) |
| `render-three-textures` | component | images from `io.image` as three.js textures, the same pixels in Node and the browser, and atlases for many cards | product-studio's plumbing (no look) |
| `review-av-timeline` | component | the sound as pictures and the picture's change per frame on one timeline; picture-to-sound offsets in ms | opening film's review method |
| `review-picture-reuse` | component | the shots of a video that show a picture already seen, a crop, zoom or pan counting, as analysis data from `review-shots`' shots; ORB and a RANSAC homography in OpenCV | the taste-to-plugins film's no-repeated-pictures check |
| `review-shots` | component | any video measured shot by shot as analysis data (cuts, dissolves included, camera move, levels, colour), with contact sheets; PySceneDetect, TransNet V2 (in numpy) and OpenCV | the taste-to-plugins film's reference measurements |
| `text-code-wall` | component | the project's own source as a scrolling, glitching wall under a claim | opening film |
| `text-fit` | component | text measured in a width on Canvas2D: the size that fits, greedy word wrap by Intl.Segmenter (Thai too), a line's width at a tracking, the lines as the text runs review reads | split from `text-kinetic`; fit, wrap and tracking several films wrote again |
| `text-glyph-morph` | component | one glyph outline or word morphing into another, letter by letter or whole: contours resampled and paired, holes grown from points | the font previews' morph, made its own plugin |
| `text-glyph-outlines` | component | a font's outlines as contours, fills and extruded solids (opentype.js, earcut): per glyph, deterministic | research for 0.1.0 |
| `text-glitch-titles` | component | big title cards drawn into the frame, swapping through ASCII noise, in four layouts | opening film (was `text-feature-captions`) |
| `text-glyph-points` | component | text as a point set, for particles that form words | opening film |
| `text-scramble` | component | scramble, decode, band glitch: Canvas2D text primitives | opening film (was `text-kinetic`) |
| `text-timed-cues` | component | lyrics and subtitles read from LRC, SRT, VTT and Whisper or STT JSON; the line and the word at render time | split from `audio-beat-clock`; later in-house films |

Stills of any t and a contact sheet come from `npx shaderera still`, not from a plugin.

Left in the film: the MATTER particle engine, blob tracking and the score. They are tied to
that film, and a plugin is only what another film can use as it is.

Shaderera's own plugins at `https://shaderera.com/r` are built from these folders. From the
repository root, after `pnpm install` (the publish loop fills the folder you name, which
`search` and `add` then read with `--from` or `SHADERERA_PLUGINS`):

```
pnpm --filter @shaderera/plugins test        # every plugin renders, headless
for d in packages/plugins/*/; do [ -f "$d/shaderera.item.json" ] && node apps/cli/bin/shaderera.js publish "$d" --from <folder>; done
```
