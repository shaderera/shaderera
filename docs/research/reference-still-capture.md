# Reference still capture

Research of 2026-11-04, for reference copying: a person hands a still (a poster from Pinterest or
a designer, a screenshot, a website's hero) and the film matches it 1:1. Motion references are in
[reference-motion-capture.md](reference-motion-capture.md). This note read
[0011](../adr/0011-experts-and-agents-no-taste-lock.md), [0017](../adr/0017-outside-media.md),
[analysis.md](../analysis.md), [plugins.md](../plugins.md) and `shaderera still --compare`
([cli.md](../cli.md#still)), and outside primary sources: the Chrome DevTools Protocol source,
OCR projects' own docs and licences, papers, the US Copyright Office and Pinterest's terms.

## Conclusion

A still reference has two very different sources, and they need different tools:
- **A live page is exact.** Chrome already knows every font it used, every size, colour and line
  box. Reading those facts over CDP is plumbing with no model. It belongs in the planned web
  capture plugin, written as a `shaderera.analysis/1` artifact.
- **An image is a guess.** OCR gives text, line boxes and angles, not fonts or sizes in points.
  PaddleOCR PP-OCRv5 is the best open fit (Apache-2.0, a Thai model, CPU). Apple Vision is a free
  second opinion on macOS. It becomes an analyser beside `image-regions`, run by the person.
- **Font identification from an image is not reliable.** The best open model reaches about 49%
  top-1 on its own synthetic set. Leave the choice to the person; the agent can render candidates
  and measure them.
- **Measuring the clone** needs SSIM, per-region scores with masks, and an edge score next to
  PSNR and ΔE. All of these fit in pure TypeScript, like `review/compare.ts` today. Registration
  of a photographed poster needs OpenCV and stays a user-run script.
- **Rights are the person's call** (0017). The guide says what the sources say: Pinterest forbids
  scraping, a typeface and a general layout are not registrable in the US, the artwork is.

Every number is a measurement. Nothing passes or fails unless requirements.json declares it
(0011, point 6).

## 1. A live page: facts from Chrome

### What CDP gives

- **The font Chrome really drew with.** `CSS.getPlatformFontsForNode` "Requests information about
  platform fonts which we used to render child TextNodes in the given node". Each entry has
  `familyName`, `postScriptName`, `isCustomFont` ("downloaded or resolved locally") and
  `glyphCount` ([CSS.pdl](https://github.com/ChromeDevTools/devtools-protocol/blob/b0d96c6cdf39e5583e67a3762b2815a33154455b/pdl/domains/CSS.pdl);
  [docs](https://chromedevtools.github.io/devtools-protocol/tot/CSS/#method-getPlatformFontsForNode)).
  This is the only source that shows a fallback: a Thai line in a Latin web font reports two
  fonts with their glyph counts. `font-family` in CSS only names what was asked for.
- **Web font files.** `CSS.fontsUpdated` carries a `FontFace` with `fontFamily`, `fontWeight`,
  `unicodeRange`, `src`, `platformFontFamily` and variation axes (same file). In the page,
  `document.fonts` lists the `FontFace`s and their load status
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Document/fonts)).
- **Computed style per node.** `CSS.getComputedStyleForNode` returns the resolved values (same
  file): `font-size`, `line-height`, `letter-spacing`, `color`, `text-transform`, `font-feature-settings`.
- **Everything at once.** `DOMSnapshot.captureSnapshot` takes a list of `computedStyles` and
  returns the flattened DOM (iframes, shadow DOM flattened), layout `bounds`, `paintOrders`,
  `offsetRects` and `clientRects`, and a `TextBoxSnapshot` per line fragment: `bounds`, `start`
  and `length` into the text. The source warns that "The exact layout should not be regarded as
  stable and may change between versions"; `includeBlendedBackgroundColors` and
  `includeTextColorOpacities` are experimental
  ([DOMSnapshot.pdl](https://github.com/ChromeDevTools/devtools-protocol/blob/b0d96c6cdf39e5583e67a3762b2815a33154455b/pdl/domains/DOMSnapshot.pdl)).
- **In-page geometry.** `getBoundingClientRect()` gives an element's box and `Range.getClientRects()`
  one rect per line box ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/getBoundingClientRect);
  [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Range/getClientRects)).
- **The picture itself.** `Page.captureScreenshot` is stable; the viewport and device scale factor
  are set with `Emulation.setDeviceMetricsOverride`, stable in `Emulation` (deprecated in `Page`)
  ([Page.pdl](https://github.com/ChromeDevTools/devtools-protocol/blob/b0d96c6cdf39e5583e67a3762b2815a33154455b/pdl/domains/Page.pdl);
  [Emulation.pdl](https://github.com/ChromeDevTools/devtools-protocol/blob/b0d96c6cdf39e5583e67a3762b2815a33154455b/pdl/domains/Emulation.pdl)).

### Stability

- **The `CSS` and `DOMSnapshot` domains are both marked `experimental domain`** in the protocol
  source as of its 2026-11-04 commit. `DOM.getBoxModel` is stable; `DOM.getContentQuads` is
  experimental ([DOM.pdl](https://github.com/ChromeDevTools/devtools-protocol/blob/b0d96c6cdf39e5583e67a3762b2815a33154455b/pdl/domains/DOM.pdl)).
- So the artifact records the Chrome version, and the tests record which Chrome they ran on. A
  field that goes missing fails with a message, never with a silent default.

### What a page cannot tell

- **Text drawn on a canvas, or inside an image or video, is pixels.** The DOM holds no text, font
  or box for it ([HTML canvas](https://html.spec.whatwg.org/multipage/canvas.html)). Many hero
  sections are WebGL or a video; those go through the image path below.
- **Effects on the composite** (blend modes, filters, masks) are in computed style, but what they
  produce is only in the screenshot.
- **The font file is not the font licence.** A site's web font is usually licensed to that site.
  One foundry's web licence says it "does not grant you the right to use the Fonts for broadcast
  media" ([Fort Foundry](https://fort.onrender.com/static/licenses/Fort-Foundry_Web-License.pdf)).
  An OFL font may be copied and embedded, and the licence "does not apply to any document created
  using the Font Software" ([OFL](https://openfontlicense.org/open-font-license-official-text/)).
  Capture records the family, PostScript name and `src`; it never copies the file into the
  project. The person gets the font under their own licence (the `font-*` plugins are OFL).

## 2. An image: recovering text layout

### Candidates

| Tool | Licence | Thai | Output | Size, runtime |
|---|---|---|---|---|
| PaddleOCR PP-OCRv5 | Apache-2.0, code and models | `th_PP-OCRv5_mobile_rec`, 82.68% avg. accuracy on its own set | line polygons, line angle, text, score | det 4.7 MB (mobile) or 84.3 MB (server), Thai rec 7.5 MB; CPU 58–383 ms det |
| Tesseract 5 | Apache-2.0 | `tha` in tessdata_best, 7.6 MB | hOCR / TSV: page, block, paragraph, line, word boxes; **baseline**, x-height | CPU only |
| Apple Vision | macOS SDK | `th-TH` with `.accurate` | quads per line, a box for any character range | built in, no download; macOS only |
| docTR | Apache-2.0 | a Thai vocab, but the shipped recognisers use the French vocab | rotated word boxes | PyTorch |
| Surya | Apache-2.0 code, weights modified OpenRAIL-M | 60.4% (Surya 2.5) on its benchmark | line polygons, layout, reading order | ~4.8 GB RSS on CPU |
| EasyOCR | Apache-2.0 | `th` model | word boxes | PyTorch |

Sources: PaddleOCR [README](https://github.com/PaddlePaddle/PaddleOCR) (v3.7.0, 2026-06-11) and
[OCR pipeline docs](https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/OCR.html) for
sizes, times, `dt_polys`, `rec_polys` and `textline_orientation_angles`; the Thai model's
[model card](https://huggingface.co/PaddlePaddle/th_PP-OCRv5_mobile_rec) (apache-2.0);
Tesseract [command-line usage](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html)
(hOCR `baseline`, `x_size`) and [tessdata_best](https://github.com/tesseract-ocr/tessdata_best)
(`tha.traineddata`, 7,614,571 bytes); Apple
[VNRecognizeTextRequest](https://developer.apple.com/documentation/vision/vnrecognizetextrequest)
and [boundingBox(for:)](https://developer.apple.com/documentation/vision/vnrecognizedtext/boundingbox(for:));
`supportedRecognitionLanguages()` run on this machine (macOS 27.0.1) listed `th-TH` for
`.accurate` and only six Latin languages for `.fast`; docTR
[README](https://github.com/mindee/doctr) and its
[vocabs](https://github.com/mindee/doctr/blob/main/doctr/datasets/vocabs.py) and
[CRNN configs](https://github.com/mindee/doctr/blob/main/doctr/models/recognition/crnn/pytorch.py);
Surya [README](https://github.com/datalab-to/surya) and
[multilingual table](https://github.com/datalab-to/surya/blob/master/static/docs/multilingual.md);
EasyOCR [README](https://github.com/JaidedAI/EasyOCR) and
[config](https://github.com/JaidedAI/EasyOCR/blob/master/easyocr/config.py).

### What fits posters and Thai

- **No tool publishes accuracy on posters or on Thai display type.** Every number above is the
  vendor's own set, mostly documents. The person looks at a `check.png`, as with `image-regions`.
- **PaddleOCR is built for scene text**: arbitrary quads and a line orientation classifier.
  It has the only Thai model with a stated accuracy above 80%, is small,
  runs on CPU, and is Apache-2.0 for code and weights.
- **Tesseract is for flat, straight, dark-on-light text.** Its own guide says skew "severely
  impacts the quality", that 4.x wants dark text on a light background, and that it works best
  at 300 dpi or more ([ImproveQuality](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html)).
  Its one strength is a real baseline and x-height per line.
- **Apple Vision** needs no download and reads Thai, so it is a cheap cross-check for a person on
  a Mac. It cannot run in CI on Linux.
- **Surya's weights are not free for every business** ("startups under $5M funding/revenue"),
  and its Thai score is the lowest here. docTR would need a Thai model trained first.
- **Thai has no spaces between words.** OCR line boxes hold; word boxes are each model's own
  segmentation. `text-fit` already wraps Thai by locale.

### What OCR does not give

- **A size in pixels is not a font size.** A line box spans ascenders to descenders of what is
  in it; Tesseract's `x_size` is the x-height. Thai marks above and below change the box.
  The film knows its font's metrics and fits its own size to the measured box (`text-fit`).
- **Reading order** on a poster is a design choice. Surya orders document
  blocks; on a poster the person or agent decides.
- **Text over pictures, outlined or distorted type** fails silently or with a low score. The
  score goes into the artifact; the masks from `image-regions` can say which pixels are text.

### Shape of the analyser

As [analysis.md](../analysis.md) requires: a script the person runs, apart from rendering, writing
a `shaderera.analysis/1` artifact of kind `text-lines` (say) with `source` (path, bytes, sha256),
`tool` (PaddleOCR and PaddlePaddle versions, model name and sha256 of `inference.pdiparams`,
licence), `params`, and per line: polygon in source pixels (origin top-left), angle, text,
score, and baseline and x-height where the analyser gives them. A second analyser (Apple Vision,
Tesseract) writes the same JSON, as `regions-from-masks.ts` does for regions.

## 3. Identifying the font from an image

- **DeepFont** (Adobe, 2015) reports "higher than 80% (top-5)" on its AdobeVFR set
  ([arXiv 1507.03196](https://arxiv.org/abs/1507.03196)). No weights were released with it.
- **The most used open re-implementation**, YuzuMarker.FontDetection (MIT, CJK fonts), reports at
  best 48.99% on its own synthetic set; its DeepFont run "Can't Converge"
  ([README](https://github.com/JeffersonQin/YuzuMarker.FontDetection)). Thai is not covered.
- WhatTheFont is a MyFonts service that returns fonts that MyFonts sells
  ([MyFonts](https://www.myfonts.com/pages/whatthefont)); it needs an upload and is not local.
- **So: build no identifier.** The person names the font, or a near one they own. What helps is
  measuring: render the OCR'd line in each candidate the person gives, fitted to the line box,
  and report SSIM and edge scores per candidate over that region (section 4). That ranks
  candidates; it does not choose.

## 4. Measuring the clone against the reference

Today `still --compare` gives PSNR and mean and max CIEDE2000 between two variants
([cli.md](../cli.md#still)), in 135 lines of TypeScript with no dependency
(`apps/cli/src/review/compare.ts`). A `--compare-file <png>` against a reference adds:

| Measure | What it adds | Cost |
|---|---|---|
| **SSIM** on luma | structure, not only pixel error; one map and its mean ([Wang et al. 2004](https://www.cns.nyu.edu/pub/eero/wang03-reprint.pdf)) | cheap: Gaussian 11×11 window, pure TS |
| **MS-SSIM** | the same at 5 scales, less sensitive to viewing size ([Wang, Simoncelli, Bovik 2003](https://www.cns.nyu.edu/pub/eero/wang03b.pdf)) | cheap; needs about 176 px on the short side for 5 scales (11 × 2⁴, our arithmetic) |
| **Per region** | every score over a mask: `image-regions` masks, or OCR line polygons | cheap: weight the sums by u8 coverage |
| **Edges** | Sobel magnitude compared, or an edge F-score: where type and shapes sit, apart from colour | cheap, pure TS |
| **Palette** | k-means in CIELAB as data: k centres, their shares; and each reference colour's nearest ΔE in the clone | cheap if seeded deterministically (fixed seed, sorted output) |
| **Registration** | a photographed or resized poster aligned before any score: ORB features and a RANSAC homography, or ECC refinement | needs OpenCV (Apache-2.0, [licence](https://github.com/opencv/opencv/blob/4.x/LICENSE)); a user-run script |
| SSIMULACRA2, LPIPS | perceptual scores | C++ ([BSD-3](https://github.com/cloudinary/ssimulacra2)) or a network's weights ([BSD-2](https://github.com/richzhang/PerceptualSimilarity)); not now |

- OpenCV documents `findTransformECC`, `findHomography` and `kmeans`
  ([video tracking](https://docs.opencv.org/4.x/dc/d6b/group__video__track.html);
  [feature homography](https://docs.opencv.org/4.x/d7/dff/tutorial_feature_homography.html);
  [clustering](https://docs.opencv.org/4.x/d5/d38/group__core__cluster.html)).
  scikit-image's `structural_similarity` is a reference for testing a TS SSIM
  ([skimage.metrics](https://scikit-image.org/docs/stable/api/skimage.metrics.html)).
- Registration writes a 3×3 homography into an artifact; `--compare-file` applies it and reports
  the warped area it scored. A screenshot or a designer's file at the film's size needs none.
- Sizes differ: the reference is scaled to the frame once, with the scale recorded, never cropped
  silently.

## 5. Rights

Neutral, from primary sources; not legal advice. 0017 puts the decision with the person.

- **Pinterest's Terms** (effective 2025-04-30; an update is announced for 2026-11-12): users
  "retain all rights in" what they post and agree not to post what "infringes the intellectual
  property rights of others"; "you agree not to scrape, collect, search, copy or otherwise access
  data or content from Pinterest" in unauthorised ways
  ([Terms](https://policy.pinterest.com/en/terms-of-service)). The
  [developer guidelines](https://policy.pinterest.com/en/developer-guidelines) forbid storing
  information from the API, "any automated means or form of scraping", using Pinterest Materials
  to train AI, and to "create new content from Pins". Owners file notices under the
  [copyright policy](https://policy.pinterest.com/en/copyright).
- So a Pin's poster is not Pinterest's and often not the pinner's. The rights are with whoever
  made the poster.
- **US Copyright Office, Compendium ch. 900** (01/28/2021): "typeface, typefont, lettering,
  calligraphy, and typographic ornamentation are not registrable", "regardless of how novel and
  creative" (§906.4); "The general layout or format of a book, a page, a website, a webpage, a
  poster … is not copyrightable", though a sufficiently creative selection and arrangement of
  specific content may be (§906.5)
  ([PDF](https://www.copyright.gov/comp3/chap900/ch900-visual-art.pdf);
  [37 CFR 202.1](https://www.ecfr.gov/current/title-37/chapter-II/subchapter-A/part-202/section-202.1)).
  A program that makes or uses type may be registered (§906.4): the font file is software.
- **What the guide should tell the person:**
  - A 1:1 copy reproduces the poster's photographs, illustrations and copy, which are protected
    on their own; its grid, type sizes and colours as such are not, in the US. Other countries
    differ.
  - Use a reference you made, were given, or have permission for. Otherwise take measurements
    (layout, sizes, palette) and make your own artwork.
  - Save the image yourself; no scraping of Pinterest (0017 already rules out bot-wall
    workarounds). Record it with `asset-provenance` as supplied by the person, with the Pin's
    URL and the original source if found.
  - A font seen on a site is licensed to that site. Get a licence that covers video, or use an
    open font.

## Recommendation

Smallest first:
1. **`still --compare-file <png>` in core** (plumbing, measures, never judges): PSNR, ΔE, SSIM
   and an edge score, the reference scaled once to the frame. Then `--regions <file>` scores, read
   from masks in a form analysis.md defines (its `u8` mask raster and a named list of masks or
   boxes); `image-regions` conforms to it, and core names no plugin. Pure TS beside
   `review/compare.ts`; tested against scikit-image.
2. **Style facts in the web capture plugin**: a `DOMSnapshot.captureSnapshot` of computed style
   properties, every one or the person's list, recorded in params (a list fixed to text and
   colour would drop shadows, gradients, filters, blend modes, radii and transforms unmeasured),
   `getPlatformFontsForNode` per text node, `fontsUpdated` font faces, and the screenshot, as
   one `shaderera.analysis/1` artifact recording Chrome's version. No font files copied.
3. **An image text analyser plugin** beside `image-regions`: PaddleOCR PP-OCRv5 with the Thai
   model, CPU, model sha256 recorded, `check.png`; Apple Vision as a second analyser writing the
   same JSON. Tesseract only if a film needs baselines.
4. **Palette** (Lab k-means, data only) in `analysis-scopes`, which already reads frames.
5. **Registration** as a user-run OpenCV script writing a homography, once a film has a
   photographed poster.

Guide only (`guides/`, read when a person brings a reference): rights as in section 5; how to
save a reference; that font identification is the person's, with WhatTheFont as one service;
how to read the scores.

Cut: a font identifier; Surya and docTR (weights licence, no Thai model); SSIMULACRA2 and LPIPS
for now; any default threshold or "match score" that says a clone is good enough.

## Open

- How DOMSnapshot `textBoxes` behave for Thai (marks above and below, line fragments) and for
  `font-variation-settings`: not run.
- PaddleOCR Thai on real posters and on Thai display faces: no public evaluation found; needs an
  in-house test set.
- Whether Pinterest's licence to "our users" covers anything outside the service, and what the
  2026-11-12 update changes: not read.
- Thai copyright law on typefaces and layout: not checked; only US sources were read.
- Apple Vision's Thai list was read on macOS 27.0.1 only; the first macOS version with Thai was
  not found.
- OpenCV doc pages answered 403 to scripts; their contents are from knowledge, not re-read today.
