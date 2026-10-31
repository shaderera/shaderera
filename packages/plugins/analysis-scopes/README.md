A frame measured the way a colourist reads scopes, as numbers an agent reads to decide a grade: levels, histogram, waveform, RGB parade, balance by tonal band, and a vectorscope summary.

```ts
import { scopes } from './color/scopes.ts'

const s = scopes(await host.io.image('footage/plate.png'))  // or a canvas's getImageData(0, 0, w, h)
const hdr = scopes(frame, { luma: 'bt2020', bands: 8, bins: 16 })
```

It takes straight RGBA, rows from the top, as `{ width, height, data }`: core's `DecodedImage`
(8 or 16 bits), a canvas's `ImageData`, a footage frame. It reads the code values as they are,
sRGB-encoded as a scope on a display signal shows them; alpha is not read. A frame in linear light
is encoded first (`render-srgb`). It returns one plain object, and never says good or bad.

A dark frame, as `scopes` gives it (the histogram and parade left out):

```json
{
  "luma": "bt709",
  "pixels": 2073600,
  "levels": {
    "r": { "mean": 0.2333, "black": 0.1176, "white": 0.349, "clipped": 0, "crushed": 0 },
    "y": { "mean": 0.1857, "black": 0.1137, "white": 0.2588, "clipped": 0, "crushed": 0 }
  },
  "waveform": [{ "low": 0.1137, "median": 0.1647, "high": 0.2157 }, "… 8 bands, left to right"],
  "balance": {
    "shadows": { "share": 100, "rg": 0.0588, "bg": -0.0176 },
    "midtones": null,
    "highlights": null
  },
  "vectorscope": {
    "hueDeg": 117.2,
    "cast": 0.034,
    "saturation": { "mean": 0.0493, "std": 0.0258 },
    "skin": { "share": 19.33, "offsetDeg": -1 }
  }
}
```

An agent reads it so: luma's white point is 0.26, so the brightest 0.5 % of the frame stops at a
quarter of the range, and every pixel is a shadow. In the shadows red sits 0.06 over green and
blue 0.02 under it: warm, though with no neutral in the frame that is the subject's colour as much
as a cast. The vectorscope's hue of 117° is the same mix, subject colour and cast together. The
19 % under `skin` are skin-hued pixels, not a person: this frame has none. Nothing clips or
crushes, so the levels can be lifted and spread before anything is lost. Measure again after the
grade.

To judge skin, run `scopes` on a crop of the face and read `skin.offsetDeg`. To judge a cast, read
`balance` where the picture is neutral (a grey wall, a white shirt): a neutral has 0 there.

- `levels`: per channel `r`, `g`, `b` and luma `y`, 0–1: `mean`, `black` (the 0.5th percentile)
  and `white` (the 99.5th); `clipped` and `crushed`, the % of pixels at 250 or more and 5 or less
  of 255, as `review` counts them. Luma's black and white are the frame's black and white points.
- `histogram`: the % of pixels in each of `bins` equal bins from black (16), per channel and luma.
- `waveform`: luma by column band, left to right (`bands`, 8), each band's 5th, 50th and 95th
  percentiles as `low`, `median` and `high`. `parade`: the same for `r`, `g` and `b`.
- `balance`: by luma, `shadows` under 1/3, `midtones`, `highlights` from 2/3: each band's `share`
  of the pixels (%), and its mean R − G (`rg`) and B − G (`bg`), 0–1. A grey has 0 in every band;
  `null` is a band with no pixel.
- `vectorscope`, in Y'CbCr of the luma's matrix: `hueDeg`, the hue of the mean chroma in degrees
  from +Cb towards +Cr (red 103°, green 230°, blue 355° in BT.709), the subject's colour and any cast
  together, `null` when `cast` is under 0.004 (one 8-bit code); `cast`, that mean's distance from
  the centre; `saturation`, each pixel's distance from the centre (0 grey, about 0.5 a primary),
  its `mean` and `std`; `skin`, the skin-hued pixels (not people), within 15° of the skin-tone
  line at 123° with a saturation of 0.02 to 0.3: their `share` (%) and `offsetDeg`, their mean
  angle from the line (positive towards yellow, negative towards red; `null` with none).

Luma is BT.709 (`0.2126 R + 0.7152 G + 0.0722 B`, as `review` measures it) or BT.2020 for an
`hdr10` film's signal. Percentiles are 8-bit codes, a 16-bit image rounded to them. Values are
rounded to 4 decimals, shares to 2, angles to 1. `bins` and `bands` are floored and kept to 1–256.

On an `hdr10` signal every number here is a PQ code value, not light. `clipped`, `crushed`
and the balance bands use SDR points: on PQ, `clipped`'s 250 is about 8297 nits, and the bands'
1/3 and 2/3 about 15 and 456 nits. Read a PQ frame against PQ's own anchors instead: 100 nits is 0.508, 203 nits (HDR reference
white) 0.581, 1000 nits 0.752 and 4000 nits 0.903.

This does one job. It draws no scope images and no false colour, and takes no linear float frame.
A 1920 × 1080 frame takes about 0.2 s on the CPU.
