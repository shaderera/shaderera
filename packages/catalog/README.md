# Catalog

The official items of the Shaderera registry (decision 0008), one folder each, MIT. Each folder
is what `shaderera-registry publish` reads: a `shaderera.item.json` label, a `README.md` that
`info` prints, and the files `add` copies into a project at the same paths.

They come from films that were made and accepted. Each one was made generic: no film's numbers,
its options as parameters, defaults that render well. Once added, an item is the project's own
code, to change freely.

Items are named `<category>-<thing>`, so related items sort together and the name says what it
is: `audio`, `camera`, `font`, `format`, `look`, `motion`, `render`, `review`, `text`.

| Item | Type | What it does | From |
|---|---|---|---|
| `audio-beat-clock` | component | measure a song (tempo fitted to its onsets, bars, onsets, bands) and read timed text (LRC, SRT, VTT, Whisper JSON); a clock, band levels, the line and the word at render time | opening film; tempo fit and timed text from later in-house films |
| `audio-hall-ending` | component | an ending that rings out in a hall and dies to silence (ffmpeg) | opening film |
| `camera-keyframes` | component | a 3D camera as shots: orbit, dolly, crane, cut, exact framing, lenses in mm, shift, focus; WebGPU or three.js; core's camera contract | opening film, ideas from camera-controls and Cinemachine |
| `camera-shake` | component | breathe, handheld, impact: seeded noise and hit envelopes as formulas of t | ideas from drei CameraShake |
| `font-ibm-plex-mono` | media | IBM Plex Mono, OFL | opening film |
| `font-ibm-plex-sans` | media | IBM Plex Sans, OFL | an in-house film |
| `font-instrument-serif` | media | Instrument Serif, OFL | an in-house film |
| `font-stix-two-text` | media | STIX Two Text, OFL | opening film |
| `format-broadcast-slate` | component | a clock slate for a broadcast preroll: the spot's details and a countdown, at negative t | research for 0.1.0 |
| `format-placement-specs` | preset | what Reels ads, YouTube, Amazon CTV, EU and US broadcast loudness and a DOOH screen accept, as requirements.json placements deliver checks the file against; each with its source and the date read | research for 0.1.0 |
| `format-safe-areas` | component | where text may go per format and platform; the lens rule for tall frames | opening film |
| `look-screen-passes` | component | ascii, halftone, dither, heat, contours, pixels, inverse, row glitch: a GPU pass over any frame | opening film |
| `motion-keyframes` | component | values over time with eases (a stateless spring, bezier), paths that flow through points | opening film |
| `render-gaussian-splats` | component | 3D Gaussian splats (.splat, .ply) rendered on host.gpu with a deterministic depth sort, as a premultiplied layer | research for 0.1.0 |
| `render-image-textures` | component | PNG/JPEG decoded the same in Node and the browser, atlases for many cards, WebP and video frames to PNG once | product-studio's plumbing (no look) |
| `render-three-host` | component | three.js WebGPURenderer on host.gpu, deterministic, the frame as a GPU texture layer | product-studio's plumbing (no look) |
| `review-av-timeline` | component | the sound as pictures and the picture's change per frame on one timeline; picture-to-sound offsets in ms | opening film's review method |
| `text-code-wall` | component | the project's own source as a scrolling, glitching wall under a claim | opening film |
| `text-feature-captions` | component | big captions that swap through ASCII noise, in four layouts | opening film |
| `text-glyph-outlines` | component | a font's outlines as contours, fills and extruded solids (opentype.js, earcut): per glyph, deterministic | research for 0.1.0 |
| `text-glyph-points` | component | text as a point set, for particles that form words | opening film |
| `text-kinetic` | component | scramble, decode, glitch, fit: Canvas2D text primitives | opening film |

Stills of any t and a contact sheet come from `npx shaderera still`, not from an item.

Left in the film: the MATTER particle engine, blob tracking and the score. They are tied to
that film, and the registry holds only what another film can use as it is.

From the repository root, after `pnpm install` (the publish loop fills `~/.shaderera/registry`,
or `SHADERERA_REGISTRY`, which `search` and `add` read too):

```
pnpm --filter @shaderera/catalog test        # every item renders, headless
for d in packages/catalog/*/; do [ -f "$d/shaderera.item.json" ] && node apps/registry/bin/shaderera-registry.js publish "$d"; done
```
