ASC CDL files read and written: a grade made in Resolve or on set comes in as plain numbers, and a grade made here goes out to a colourist as a `.cc`, `.ccc` or `.cdl` file.

```ts
import { readCdl, writeCdl } from './color/cdl-files.ts'
import { cdl } from './color/primary.ts'

// once: the file into its corrections, in the file's order
const [grade] = readCdl(new TextDecoder().decode(await host.io.read('grades/sh010.cc')))

// on the CPU: a swatch through it; in a shader, the same numbers into PRIMARY_WGSL's cdl
const swatch = cdl([0.4, 0.35, 0.3], grade.slope, grade.offset, grade.power, grade.saturation)

// and corrections back to a file
const text = writeCdl([{ id: 'sh010', ...grade }], 'cc')
```

- `readCdl(text)`: the three forms of the ASC CDL XML. A `.cc` is one `<ColorCorrection>`, a
  `.ccc` a `<ColorCorrectionCollection>` of them, a `.cdl` a `<ColorDecisionList>` of
  `<ColorDecision>`s each holding one. It gives an array of
  `{ id?, description?, slope: [r, g, b], offset: [r, g, b], power: [r, g, b], saturation }`, one
  per `<ColorCorrection>`, in the file's order. The values are read inside their nodes only, as
  OpenColorIO reads them. A missing `SOPNode` or `SatNode` is identity; a `SOPNode` needs all of
  `Slope`, `Offset` and `Power`. It reads what tools write: the v1.01 or v1.2 namespace, a namespace
  prefix, `SATNode` for `SatNode`, an XML declaration, comments, CRLF, a BOM, numbers spread over
  lines, CDATA. A bad file throws and says what is wrong: no `ColorCorrection`, a tag or comment
  not closed, a value that is not three finite numbers (saturation one), a slope or saturation below
  0, a power of 0 or below, an id used twice.
- `writeCdl(corrections, form)`: the corrections as `'cc'` (exactly one), `'ccc'` or `'cdl'` text,
  in the v1.2 namespace, `id` and description escaped. Reading it again gives the same corrections.

The numbers are what `color-primary`'s `cdl` takes (requires nothing: install `color-primary` for
`cdl` itself). The CDL works on the values its colourist graded, often log footage or display
values 0–1: its README says where it goes.

This does one job. It is a scan for the CDL's elements, not an XML parser. Only a correction's own
`Description` is kept; those inside its `SOPNode` and `SatNode`, `InputDescription`,
`ViewingDescription` and a `.cdl`'s `MediaRef` are not, and a `ColorCorrectionRef` (a correction
held in another file) is not followed.
