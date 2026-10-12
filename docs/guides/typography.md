# Typography and copy

For any request that touches words: headlines, lines, offers, CTAs, Thai or English copy, fonts.

## Keep what the brief fixes
- Copy in quotes is exact: spelling, case, punctuation, line order. Put each exact line in
  `requirements.json` `copy` so review checks it verbatim.
- A brand font the person supplied is loaded through `io.font` and used as given; record it in
  `ASSETS.md` with its licence as stated by the person.
- Any other font needs a licence that allows the use (OFL faces do), recorded in `ASSETS.md`. Do
  not download fonts unless the person asks.

## Text in the engine
- `io.font(path, family)` registers a font file for the 2D context, the same in Node and the
  browser. Text drawn with Canvas2D is a raster.
- Text as points, outlines or geometry needs the font's outlines: a font parser in the project,
  the `text-glyph-points` item for point sets, or `text-glyph-outlines` for contours and solids.
- Review reads the text a source reports in `inspect` (or the DOM's text in the browser host) for
  its `copy`, `glyphs`, `text-fit`, `text-overlap` and `reading` checks. Reading time, overlap and a
  safe area are judged only when requirements.json declares them (`readingTime`, `textOverlap`,
  `safeArea`); otherwise review reports what it measured.

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
