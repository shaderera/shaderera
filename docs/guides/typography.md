# Typography and copy

For any request that touches words: headlines, lines, offers, CTAs, Thai or English copy, fonts.

## Keep what the brief fixes
- Copy in quotes is exact: spelling, case, punctuation, line order. Put each exact line in
  `requirements.json` `copy` so review checks it verbatim.

## Fonts
A new project has no font: Shaderera has no house style. Find one in this order:
1. **The brand's font files, from the person.** Put them in the project (for example
   `assets/fonts/`) and use them as given. Record each in `ASSETS.md` with the licence the person
   states.
2. **No brand font:** ask which font to use. Do not download fonts unless the person asks.
3. **Shaderera's own plugins** have four OFL fonts: `font-ibm-plex-mono`, `font-ibm-plex-sans`,
   `font-instrument-serif` and `font-stix-two-text`. Add one when the person picks it:
   `npx shaderera add font-ibm-plex-sans` copies the files and their licence into
   `assets/fonts/`.

Any font needs a licence that allows the use (OFL faces do), recorded in `ASSETS.md`.

Load each file once, in `open`, then name its family in `ctx.font`:

```ts
await host.io.font('assets/fonts/Brand-Bold.ttf', 'Brand Bold') // a path in this project
ctx.font = '84px "Brand Bold"'
```

`io.font(path, family)` registers a TrueType or OpenType file (`.ttf`, `.otf`) under that family
for the 2D context, the same in Node and the browser. The path is relative to the project, and
Node refuses one outside it. Review's `glyphs` check reads the files loaded this way.

## Text in the engine
- Text drawn with Canvas2D is a raster.
- Text as points, outlines or geometry needs the font's outlines: a font parser in the project,
  the `text-glyph-points` plugin for point sets, or `text-glyph-outlines` for contours and solids.
- Review reads the text a source reports in `inspect` as runs,
  `{ id, text, box: [x, y, w, h], font }` in frame pixels (`docs/protocol.md`, "Text runs";
  any other shape is skipped with no warning), or the DOM's text in the browser host, for
  its `copy`, `glyphs`, `text-fit`, `text-overlap` and `reading` checks. Reading time, overlap and a
  safe area are judged only when requirements.json declares them (`readingTime`, `textOverlap`,
  `safeArea`); otherwise review reports what it measured.
- The `text-fit` plugin's `textRuns` turns wrapped lines into those runs, one a line, measured
  in the font they are drawn in.

## Thai
- Set Thai only in a face that has Thai (Trirong, Noto Sans/Serif Thai, IBM Plex Sans Thai,
  Kanit, Prompt). Latin faces draw Thai as empty boxes, with no error: review's `glyphs` check
  catches it.
- Thai has no spaces between words. Lines wrap at `Intl.Segmenter('th', { granularity: 'word' })`
  boundaries; an explicit `\n` chooses a phrase break.
- Tone marks sit above the line and some vowels below it: Thai needs more line height than Latin,
  or the marks of one line touch the next.

## Check
Run review (MCP `review`, or `npx shaderera review`): `copy`, `glyphs`, `text-fit`,
`text-overlap`, and contrast in diagnostics. Then look at the frames: numbers do not tell you
whether the type is right for the film.
