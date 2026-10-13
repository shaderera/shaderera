# Plugin previews

The shared harness that renders a short preview of each plugin for the website's /plugins page:
1080×1080, 30 fps, a 6 s loop, the plugin doing its job under the same caption (the plugin's
name and one plain sentence). Each plugin carries its own preview in `preview/` beside its label;
this folder holds only what they share.

```
packages/plugins/<plugin>/preview/
  preview.json   the caption, the states, the default state, sound, the poster time, crf?
  index.ts       the picture: its default export is an OpenPreview (src/preview.ts)
  *.ts           its own helpers, and make.ts when it makes assets (sound, a film to review)
packages/plugins/previews/
  src/composition.ts   opens ../../<plugin>/preview/index.ts, chosen by the variant
  src/house.ts         the house style every preview draws with
  src/caption.ts       the caption band under every preview
  src/preview.ts       the shared types and fonts
  src/specimen.ts                   the font previews' type specimen
  scripts/render.ts    finds the previews, writes the variants, renders
  scripts/assemble.ts  copies the plugins in, as `add` lays them out
```

Each state is a variant: `<plugin>` is the default state, `<plugin>.<state>` the others.
`scripts/render.ts` finds every `packages/plugins/*/preview/preview.json` and writes the variants,
and the list of plugins, into `shaderera.json`, so nothing here lists the plugins by hand.

The house style (`src/house.ts`) is the opening film's: a black ground, big uppercase words in
Plex Mono SemiBold in the top-left and bottom-right corners that decode in when they change, a
small note in Instrument Serif Italic, tiny mono labels in the corners, a huge faint outlined
index number behind the picture, and red for markers only. The index number is the plugin's
place among the plugins with a preview, in alphabetical order.

The previews use the plugins as `shaderera add` lays them out: `scripts/assemble.ts` copies
every plugin's files here at their paths (`src/looks/`, `src/type/`, `src/music/`, `tools/`,
`assets/fonts/`, gitignored), and a preview imports them from there
(`../../previews/src/looks/looks.ts`). So a preview that renders proves the plugin works as a
film would use it. `preview/` is never in a plugin's `files`, so `add` and `publish` leave it out.

Every asset is made in code: the music for `audio-beat-clock` (four bars at 160 BPM, drums, bass
and a lead stab phrase) comes from its `preview/make.ts`, which then measures it with the plugin's
own analyser. Fonts come from the OFL font plugins.

## Render

With ffmpeg (and libwebp) on the PATH:

```sh
node scripts/render.ts                      # every plugin, every state, into ../<plugin>/preview/out/
node scripts/render.ts audio-beat-clock     # one plugin
node scripts/render.ts --variants           # only write the variants into shaderera.json
```

Each plugin's `preview/out/` then holds what the page needs: `<plugin>.mp4` (the default state,
with sound for an audio plugin), `<state>.mp4`, `loop.webp` and `loop-<state>.webp` (480, 15 fps,
for the grid), `frames/0000.webp`… (30 frames over the loop, for scrubbing), `poster.webp` and
`preview.json` (the caption, the states and the timing). The mp4s are x264 at crf 20, or the
plugin's `crf`: a busy picture (particles, a wall of text) sets a higher one to stay near 4 MB. A
loop over 1.5 MB steps down in quality, then to 12 or 10 fps.

`preview/out/` is gitignored and never committed: the previews are deterministic, so the code is
what is kept. A maintainer uploads the renders.

To look while working, from this folder (the first two lines once, and again when a plugin's
files or the list of previews change; `make.ts` only for a plugin that has one):

```sh
node scripts/assemble.ts
node scripts/render.ts --variants
node ../audio-beat-clock/preview/make.ts
node ../../../apps/cli/bin/shaderera.js still 0.5 2 3.5 5 --sheet --variant text-kinetic.glitch
node ../../../apps/cli/bin/shaderera.js render --variant look-screen-passes --out out/look.mp4
```

Typecheck with `npx tsc -p .` here. It covers `src/`, `scripts/` and every plugin's `preview/`;
the plugins package's own `typecheck` does not include them.

## A new plugin

Add `preview/preview.json` and `preview/index.ts` to the plugin's folder, drawing with
`src/house.ts`, then run `node scripts/render.ts <plugin>`. See "The preview" in
[docs/plugin-guide.md](../../../docs/plugin-guide.md#the-preview).
