# Formats, variants and delivery

For requests about vertical, square or landscape versions, short cutdowns, campaign sets, and
exporting files. The reference is `docs/protocol.md` (variants) and `docs/delivery.md`.

## Variants

- Outputs are `variants` in `shaderera.json`: a name, a size and/or a duration, optional params.
  The source lays itself out from the size it is opened with. A variant is never a crop of
  another.
- Platform UI covers part of a vertical (9:16) social frame; each platform publishes its own safe
  zone. Declare the placement's in `requirements.json` (`safeArea`, or `placements`; the
  `format-placement-specs` plugin has current specs with their sources): review checks text against
  it, and there is no default.
- A cutdown (for example 6 s) is a variant with its own `duration`. How the film fits the shorter
  time is the film's code; review checks that the required copy, and an end hold if one is
  declared, still fit.
- Locales: a `locale` param selects copy; check each locale's text fits its layout (Thai often
  runs longer or shorter than English). Copy that belongs to some outputs only gets `variants` in
  requirements.json (`{ "text": "ลด 30%", "variants": ["story-th"] }`; `main` is the manifest's
  own format), so each output is checked for its own lines.
- Exact agency timestamps are time locks (`requirements.json` `locks` with
  `{ kind: 'time', at, id }`, naming the beat or shot, and the beat marked `locked`): never move
  them. A time lock keeps *when*
  something happens; a later revision may still change what the frame shows. A frame lock
  (`{ kind: 'frame', at }`) freezes pixels: use it only for a frame a person approved and asked
  to keep exactly.

## One film in 16:9 and 9:16 at once

Make both outputs from the start, and look at, check and review them together: a layout that
works in one ratio and breaks in the other shows up while the film is made, not at delivery.

1. **Declare both** in `shaderera.json`:

   ```json
   "variants": {
     "16:9": { "width": 1920, "height": 1080 },
     "9:16": { "width": 1080, "height": 1920 }
   }
   ```

2. **Lay out by the name.** The source is opened with the variant's size in `host.manifest` and
   its name in `host.variant` (`undefined` for the manifest's own output). Choose the layout
   from the name, not by guessing from the width and height; what each layout looks like is the
   film's own code (`docs/protocol.md`, "Variants"):

   ```ts
   const open: Open = ({ io, manifest, variant }) => {
     const stacked = variant === '9:16'
     // ...
   }
   ```

3. **Look at both side by side:** `npx shaderera still 1 2.5 4 --variant 16:9,9:16 --sheet`
   writes each still and one sheet, a row per moment, the two at the same height, labelled with
   their name, t and size, with the safe area `requirements.json` declares drawn on it. Through
   MCP: `still` with `variants: ["16:9", "9:16"]` returns that sheet.
4. **Check and review both:** `npx shaderera check --variant 16:9,9:16` and `npx shaderera
   review --variant 16:9,9:16` (or `--variants all`, which adds `main` unless a variant already renders it) open one host per
   variant and run them at once; the lines are grouped under each name, each finding names its
   variant, and the exit code is the worst. MCP's `check` and `review` take `variants` too.
5. **Preview both in the studio:** `npx shaderera studio`; the studio page can show the
   variants side by side on one timeline (`docs/studio.md`).
6. **Deliver both:** `npx shaderera deliver --variants 16:9,9:16` makes a job for each, then
   renders, reviews and indexes them in one batch.

## Delivery

- Export a saved version, not the working tree: `npx shaderera job` freezes a revision with its
  variant and params; `npx shaderera render --job <name>` renders exactly that.
- The review mp4 is for sharing and approval; `--master` raises the quality for delivery. ProRes
  (`--format prores-hq`, or `prores-4444` with alpha) is for an agency or an editor. A PNG
  sequence with WAV audio and `delivery.json` (`job --png`) is the finishing handoff for an editor
  or colourist.
- A placement's file rules (bitrate, edit lists, loudness) are declared in `requirements.json`
  `placements`; `deliver` checks the file and names the flag that fixes it.
- Shaderera composites 8-bit display-referred frames (16-bit for ProRes and `--bits 16` PNGs on
  the GPU). HDR, scene-linear EXR or render passes must come from the renderer itself or an
  external pipeline; changing the encoder cannot add precision that was not rendered.

## Check

Check every delivered variant: `npx shaderera review --variant a,b` (or MCP `review` with
`variants`), and `npx shaderera still <t>... --variant a,b --sheet` for the moments that
changed, side by side.
Deliver them together with `npx shaderera deliver --variants a,b [--locales en,th]`: each output
is rendered, reviewed with its own size and placement, and indexed.
