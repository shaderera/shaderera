# Catalog previews

One Shaderera project that renders a short preview of each catalog item for the website's
/catalog page: 1080×1080, 30 fps, a 6 s loop, the item doing its job under the same caption
(the item's name and one plain sentence). Each item has a few states a visitor can switch
between, and each state is a variant: `<item>` is the default state, `<item>.<state>` the
others. The captions and states are in `src/items.ts`; each item's picture is `src/<item>.ts`.

The previews use the items as `shaderera add` lays them out: `scripts/assemble.ts`
copies every item's files here at their paths (`src/looks/`, `src/type/`, `src/music/`, `tools/`,
`assets/fonts/`, gitignored), so a preview that renders proves the item works as a film would
use it. Nothing here is in any item's `files`.

The music for `audio-beat-clock` is made in code (`scripts/make-track.ts`: four bars at 160 BPM,
drums, bass and a stab on every lyric word, with the words as `audio/beat.lrc`) and measured with
the item's own analyser, so every asset is this repository's: code, and the catalog's OFL fonts.

## Render

From this folder, with ffmpeg (and libwebp) on the PATH:

```sh
node scripts/render.ts                      # every item, every state, into out/<item>/
node scripts/render.ts audio-beat-clock     # one item
```

`out/<item>/` then holds what the page needs: `<item>.mp4` (the default state, with sound for
an audio item), `<state>.mp4`, `loop.webp` and `loop-<state>.webp` (480, 15 fps, for the grid),
`frames/0000.webp`… (30 frames over the loop, for scrubbing), `poster.webp` and `preview.json`
(the caption, the states and the timing).

To look while working, from this folder (the first three lines once; the track and its analysis
only for `audio-beat-clock`):

```sh
node scripts/assemble.ts
node scripts/make-track.ts
node tools/analyze-music.ts audio/beat.wav --min-bpm 120 --max-bpm 180
node ../../../apps/cli/bin/shaderera.js still 0.5 2 3.5 5 --sheet --variant text-kinetic.glitch
node ../../../apps/cli/bin/shaderera.js render --variant look-screen-passes --out out/look.mp4
```

Typecheck with `npx tsc -p .` here (the catalog's own `typecheck` does not include this folder).

## A new item

Write `src/<item>.ts` (an `OpenPreview`: the picture under the caption, opened in a state), list
it in `src/items.ts` and in `PREVIEWS` in `src/composition.ts`, and add its variants to
`shaderera.json`.
