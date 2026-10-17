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
is: `asset`, `audio`, `camera`, `font`, `format`, `image`, `look`, `motion`, `render`, `review`,
`text`.

| Plugin | Type | What it does | From |
|---|---|---|---|
| `asset-provenance` | component | where each outside file came from: a record per file (source, licence, author, segment, sha256), the ASSETS.md table and the description's credits | an in-house explainer film, 2026-10-16 |
| `audio-beat-clock` | component | measure a song (tempo fitted to its onsets, bars, onsets, bands); a clock, band levels and hits at render time | opening film; tempo fit from later in-house films |
| `audio-hall-ending` | component | an ending that rings out in a hall and dies to silence (ffmpeg) | opening film |
| `audio-listen` | component | hear a recording with Earshot (the person's own install) and keep the takes that match a description as trims stamped to its bytes, each with its peak, so a clip lands on a hit point | decision 0018, before a film (experimental) |
| `audio-voice-repace` | component | re-pace a narration (long pauses between words shortened, named ones kept, tempo with the pitch kept, ffmpeg) and a time map the edit's times follow | an in-house narrated film, its paced voice |
| `camera-ken-burns` | component | the crop of a still a frame shows: framed on a box with headroom, moved between two framings at an even speed (scale in log space), kept inside the picture | an explainer film on cats in art (POC), 2026-10-15 |
| `camera-keyframes` | component | a 3D camera as shots: orbit, dolly, crane, cut, exact framing, lenses in mm, shift, focus; WebGPU or three.js; core's camera contract | opening film, ideas from camera-controls and Cinemachine |
| `camera-shake` | component | breathe, handheld, impact: seeded noise and hit envelopes as formulas of t | ideas from drei CameraShake |
| `font-ibm-plex-mono` | media | IBM Plex Mono, OFL | opening film |
| `font-ibm-plex-sans` | media | IBM Plex Sans, OFL | an in-house film |
| `font-instrument-serif` | media | Instrument Serif, OFL | an in-house film |
| `font-stix-two-text` | media | STIX Two Text, OFL | opening film |
| `format-broadcast-slate` | component | a clock slate for a broadcast preroll: the spot's details and a countdown, at negative t | research for 0.1.0 |
| `format-placement-specs` | preset | what Reels ads, YouTube, Amazon CTV, EU and US broadcast loudness and a DOOH screen accept, as requirements.json placements deliver checks the file against; each with its source and the date read | research for 0.1.0 |
| `format-safe-areas` | component | where text may go per format and platform, and the corner free for a credit; the lens rule for tall frames | opening film |
| `image-regions` | component | named regions of a photograph (mask, box, centre, the region that holds each) as analysis data; SAM 3.1 from words, or painted masks | a collage POC, 2026-10-14 |
| `look-blur` | component | blur one frame, Gaussian, bokeh, directional or radial, by an amount from shapes, a map or depth: a sharp window, tilt-shift, depth of field | research: a poster's sharp window in a blurred world |
| `look-film-grain` | component | film grain: Gaussian, sized, strongest in the mid-tones, mono or colour | split from `look-screen-passes` (0.2.0) |
| `look-paper-edges` | component | a print on paper: cut out along any shape with a paper border, or a strip cut straight or torn, with white core and fibre | a collage POC, 2026-10-14 |
| `look-row-glitch` | component | bands of rows thrown sideways, and a real pixel sort of runs of light, along rows or columns | split from `look-screen-passes` (0.2.0) |
| `look-screen-passes` | component | the frame in another medium: ascii, halftone, dither, heat, contours, pixels, inverse; ink, paper, cell and palette as parameters | opening film |
| `look-tonemap` | component | linear light to display-referred colour through Khronos PBR Neutral or AgX, as WGSL functions and a CPU version with the same values | the Wallloom opening film's output shader |
| `look-vignette` | component | the edges towards black or a colour, in linear light, round, the frame's shape or a given ellipse | split from `look-screen-passes` (0.2.0) |
| `motion-keyframes` | component | values over time with eases (a stateless spring, bezier), paths that flow through points | opening film |
| `render-bvh` | component | ray queries against triangles on the GPU: a binned SAH tree from positions and indices, WGSL closest-hit and any-hit; no shading | the Wallloom opening film's path tracer, its traversal only |
| `render-gaussian-splats` | component | 3D Gaussian splats (.splat, .ply) rendered on host.gpu with a deterministic depth sort, as a premultiplied layer | research for 0.1.0 |
| `render-gltf-read` | component | glTF 2.0 (.gltf + .bin, or .glb) read into plain data: each primitive's typed arrays, its node's world matrix, its material as stated; refuses Draco and other required extensions by name | the Wallloom opening film, which wrote it twice |
| `render-image-textures` | component | PNG/JPEG decoded the same in Node and the browser, atlases for many cards, WebP and video frames to PNG once | product-studio's plumbing (no look) |
| `render-three-host` | component | three.js WebGPURenderer on host.gpu, deterministic, the frame as a GPU texture layer | product-studio's plumbing (no look) |
| `review-av-timeline` | component | the sound as pictures and the picture's change per frame on one timeline; picture-to-sound offsets in ms | opening film's review method |
| `review-picture-reuse` | component | the shots of a video that show a picture already seen, a crop, zoom or pan counting, as analysis data from `review-shots`' shots; ORB and a RANSAC homography in OpenCV | the taste-to-plugins film's no-repeated-pictures check |
| `review-shots` | component | any video measured shot by shot as analysis data (cuts, camera move, levels, colour), with contact sheets; PySceneDetect and OpenCV | the taste-to-plugins film's reference measurements |
| `text-code-wall` | component | the project's own source as a scrolling, glitching wall under a claim | opening film |
| `text-feature-captions` | component | big captions that swap through ASCII noise, in four layouts | opening film |
| `text-glyph-morph` | component | one glyph outline or word morphing into another, letter by letter or whole: contours resampled and paired, holes grown from points | the font previews' morph, made its own plugin |
| `text-glyph-outlines` | component | a font's outlines as contours, fills and extruded solids (opentype.js, earcut): per glyph, deterministic | research for 0.1.0 |
| `text-glyph-points` | component | text as a point set, for particles that form words | opening film |
| `text-kinetic` | component | scramble, decode, glitch, fit: Canvas2D text primitives | opening film |
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
