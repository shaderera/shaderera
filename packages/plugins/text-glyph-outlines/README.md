Text from a font file as geometry: outlines, fill triangles and a closed extruded mesh.

```ts
import { extrude, glyphOutlines, loadFont, triangulate } from './type/outlines.ts'

// in open: the file is parsed here, no host.io.font needed
const font = await loadFont(host, 'assets/fonts/IBMPlexSans-Medium.ttf')
const word = glyphOutlines(font, 'SHADERERA', { size: 1, letterSpacing: 0.02 })
// word.points: Float32Array of x, y; contour i is points [word.contours[i], word.contours[i + 1])
// word.glyphs[6]: { x, advance, bounds, contours: [first, end), commands } for the second "E"
const fill = triangulate(word)                // { positions (x, y), indices, glyphs: [{ start, count }] }
const solid = extrude(word, { depth: 0.15 })  // { positions, normals (x, y, z), indices, glyphs }

// three.js, if the film uses it:
// geometry.setAttribute('position', new THREE.BufferAttribute(solid.positions, 3))
// geometry.setAttribute('normal', new THREE.BufferAttribute(solid.normals, 3))
// geometry.setIndex(new THREE.BufferAttribute(solid.indices, 1))
// solid.glyphs[i] is a draw range: one letter can move on its own
```

Units: `size` is the em (1 by default), y up, origin at the baseline where the text starts;
`word.width`, `ascender` and `descender` are in the same units for laying the text out. Curves are
flattened in uniform steps so no point of the polyline strays more than `tolerance` (default
size / 1000) from the true curve; `commands` keep the font's own quadratics (TrueType) or cubics
(CFF), scaled and placed, for anyone who wants curves.

Winding: fill and caps are counter-clockwise seen from the outside (+z for `triangulate`), the
front cap at z = 0 facing +z, the back cap at z = -depth. Side walls are flat-shaded per segment.
Holes are found by winding and containment, not by the font's direction, so TrueType and CFF
fonts both fill correctly. The solid is closed: every edge is shared by two triangles.

`kerning` (on by default) reads GPOS, else the kern table. `variation: { wght: 700 }` sets a
variable font's axes. `ligatures: true` lets fi, fl and the like merge (off by default: one glyph
per Latin character, so `glyphs[i]` is character i).

The same font, text and options always give the same bytes.

Limits: no bevel (walls are straight); no hinting; shaping is what opentype.js 2.0 gives (Latin,
some Arabic and Thai substitutions, no mark positioning), so complex scripts may not come out
right. Overlapping contours (fonts that keep overlaps) fill correctly but the solid gets walls
inside it. Colour fonts give their plain outlines. `opentype.d.ts` declares only what this module
uses; remove it if the project installs its own types. Installs `opentype.js` and `earcut`.
