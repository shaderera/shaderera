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

Check every delivered variant: `npx shaderera review --variant <name>` (or MCP `review` with
`variant`), and `npx shaderera still --variant <name> <t>...` for the moments that changed.
Deliver them together with `npx shaderera deliver --variants a,b [--locales en,th]`: each output
is rendered, reviewed with its own size and placement, and indexed.
