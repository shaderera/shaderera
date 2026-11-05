# Colour

For requests about a grade: matching a reference, applying a LUT or a CDL the person gives,
footage shot in log, or changing one colour. How the film should look comes from the brief and
the person. This guide says which plugin does each job, in what order they go, and how to check
the result with numbers.

## Which plugin does what

These are plumbing: an agent may add one instead of writing the same code again (`AUTHORING.md`,
"Plugins"). Each gives WGSL functions for your own shader and a CPU version with the same values.
None ships a LUT, a preset or a default grade: the values come from the brief, the person or a
measurement.

| Job | Plugin |
|---|---|
| Read a frame as numbers: levels, clipping, balance by tonal band, vectorscope, skin hue | `analysis-scopes` |
| Exposure in stops, contrast around a pivot, white balance from Kelvin or a grey card, the ASC CDL | `color-primary` |
| A `.cube` LUT the person gives (from Resolve, bought, exported), and writing one back | `color-lut` |
| A `.cc`, `.ccc` or `.cdl` file from a colourist, and sending a grade back as one | `color-cdl-files` (its numbers go into `color-primary`'s `cdl`) |
| Master and RGB curves, hue vs saturation, hue vs hue | `color-curves` |
| A grade that touches one colour only (a sky, skin, a product) | `color-qualifier`: a soft matte to mix the grade through |
| Footage in S-Log3, LogC3, LogC4, V-Log or Canon Log 3; a log working space (ACEScct); converting between Rec.709, Rec.2020, P3 and the ACES and camera gamuts | `color-spaces` |
| sRGB display values to linear light and back | `render-srgb` |

## Order

The plugins convert no spaces on their own. Each README says where it goes; in short:

- Decode log footage to linear light first: `${clip.space.transfer}ToLinear` from `color-spaces`
  (the transfer the clip declares in `io.video(path, { transfer })`).
- White balance, exposure and contrast work on scene-linear light, before anything clips: a
  clipped highlight turns cyan once it is balanced.
- The CDL clamps to 0–1, as its spec does, so on scene-linear light it clips everything above 1.
  Apply it to log-encoded values (ACEScct) or to display values.
- Then the tone map and the sRGB encode (`toSrgb`). A display LUT (Rec.709 in and out, as most
  creative LUTs are) comes after them, and nothing encodes again after it. A log-to-display LUT
  replaces the tone map and the encode.
- A LUT made for SDR clamps at its domain and clips an `hdr10` film's highlights: use it on the
  `sdr` range only.

Record a LUT or CDL file from the person in `ASSETS.md`, as you would any file they supply.

## Check with numbers

- Run `scopes` on the frame before and after each change. `levels` gives the black and white
  points and how much clips or crushes. `balance` read on a neutral area (a grey wall, a white
  shirt) is 0 there when there is no cast.
- To judge skin, run `scopes` on a crop of the face and read `vectorscope.skin.offsetDeg`.
  `image-regions` gives the face's box, so you do not have to guess where the crop goes.
- To match a reference, compare the same kind of area in both frames (sky with sky, skin with
  skin), not the whole frames, which hold different subjects.
- `scopes` reads sRGB-encoded values, as a scope on a display signal does: encode a frame in
  linear light first (`render-srgb`). For an `hdr10` frame, pass `{ luma: 'bt2020' }`.
- Check banding and fine gradients in a full-size `npx shaderera still <t>`, never in a draft.

Scopes measure; they never say a grade is right. Whether it fits the film is the brief's and the
person's call.
