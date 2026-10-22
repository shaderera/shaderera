Named regions of a photograph, read as data: each one's mask, box and centre, and the region that holds it, made once by SAM 3.1 from words or from masks a person painted.

```sh
python tools/regions-sam.py assets/cat.jpg cat "cat head" eye nose     # once: regions/cat/ and check.png
node tools/regions-from-masks.ts assets/cat.jpg cat=masks/cat.png        # or from your own masks
```

```ts
import { leaves, loadRegions, maskOf, region } from './image/regions.ts'

// in open
const cat = await loadRegions(host, 'regions/cat')       // refuses regions measured from other bytes
const body = region(cat, 'cat-0')                         // { box, centre, parent?, mask, score }
const eyes = leaves(cat, 'eye')                           // the innermost eye regions
const alpha = await maskOf(host, cat, body)               // u8 coverage over body.mask.at, its width × height
```

It gives places and shapes only: what is cut, moved, covered or lined up is the film's code.

**The data.** `regions/<image>/regions.json` is a `shaderera.analysis/1` artifact (see
`docs/analysis.md` in the `shaderera` package) of kind `regions`, beside one `<id>.u8` file per
region. All in the source image's pixels, origin top-left:
- `id` is `<label>-<n>`, the label in lowercase letters, digits and dashes (it names the mask's
  file), n counting from the highest score; `label` is the word as asked for (or given); `score`
  is the analyser's confidence (1 for a painted mask);
- `box` is `{ x, y, width, height }`, `centre` the mask's centre of mass;
- `parent` is the smallest other region holding 90% of this one: an eyeball's eye, an eye's head;
- `mask` is u8 coverage 0–255 over the rectangle at `mask.at`, `width × height`, `rowStride` apart:
  any shape, with holes, separate pieces and soft edges as the analyser found them.
`source` names the image with its sha256, `tool` the analyser, model and versions, and `params`
every setting. The same image, analyser and params give the same ids, though a model can swap two
nearly equal scores on another GPU: look at `check.png` again after a rerun.

**Both analysers** run from the project root, on an image inside the project (the film reads it
by that path), and write `regions/<image name>/` or `--out`. They refuse a folder that holds
another image's regions, and clear the old masks before they write. Pixels are read as the file
stores them, as `io.image` reads them: a JPEG's EXIF orientation is not applied, so rotate such a
photo once before measuring it.

**SAM 3.1** (`tools/regions-sam.py`) finds every region a word names, people's and animals' parts
included ("eye", "nose", "cat head"); one word can answer at several sizes (an eyeball and the eye
around it), which `parent` and `leaves` sort out. A word that finds nothing is reported. Check
`check.png` before you build on it.
- Needs Python 3.12+, PyTorch with CUDA (CPU works, slowly) and Meta's `sam3` package:
  `pip install git+https://github.com/facebookresearch/sam3`, plus `einops`, `pycocotools`,
  `psutil`, and on Windows `triton-windows`. Tested with sam3 at `0570b3a` and torch 2.11 (cu128).
- The weights are your own download, under Meta's SAM License, not this plugin's MIT: accept it at
  `https://huggingface.co/facebook/sam3.1` and log in with `hf auth login`. The script fetches
  `sam3.1_multiplex.pt` (3.3 GB) once and records its sha256.
- About 40 s an image on one consumer GPU, most of it loading the model.

**Your own masks** (`tools/regions-from-masks.ts`): one PNG per region at the image's size (read
from the image's PNG or JPEG header), white or opaque inside (a PNG with alpha is read by its alpha). Any tool that writes the same JSON and
`.u8` files is an analyser too.

Still images only, for now: footage would carry each mask's source time, as `docs/analysis.md`
describes.
