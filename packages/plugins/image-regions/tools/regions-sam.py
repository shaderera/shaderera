# An analyser: regions of a photograph found by SAM 3.1 from words ("cat", "eye", "nose"), written
# as shaderera.analysis/1 regions beside a check.png that tints every region over the image.
# Run once, apart from rendering; the film reads regions/<image>/ and runs no model.
#
#   python tools/regions-sam.py assets/cat.jpg cat "cat head" eye nose
#   python tools/regions-sam.py assets/cat.jpg cat --out regions/cat --confidence 0.5
#
# Needs Python 3.12+, PyTorch with CUDA, and Meta's sam3 package; the weights are your own download
# from https://huggingface.co/facebook/sam3.1 under Meta's SAM License (see this plugin's README).
import argparse, glob, hashlib, json, os, re, sys
from importlib.metadata import version

import numpy as np
import torch
from huggingface_hub import hf_hub_download
from PIL import Image, ImageDraw

import sam3
from sam3 import build_sam3_image_model
from sam3.model.sam3_image_processor import Sam3Processor

REPO, CHECKPOINT = 'facebook/sam3.1', 'sam3.1_multiplex.pt'

ap = argparse.ArgumentParser(description='Regions of an image from SAM 3.1 text prompts')
ap.add_argument('image')
ap.add_argument('prompts', nargs='+', help='one word or short phrase per kind of region')
ap.add_argument('--out', help='the folder to write (default regions/<image name>)')
ap.add_argument('--confidence', type=float, default=0.4, help='keep regions scored at least this')
args = ap.parse_args()
# The film reads the image by its project path, so it must be inside the project (this folder).
try:
    source = os.path.relpath(os.path.abspath(args.image)).replace('\\', '/')
except ValueError:
    source = '..'
if source == '..' or source.startswith('../'):
    sys.exit(f'{args.image} is outside this project: run from the project root, with the image inside it')
out = args.out or os.path.join('regions', os.path.splitext(os.path.basename(args.image))[0])
old = os.path.join(out, 'regions.json')
if os.path.exists(old):
    with open(old, encoding='utf8') as f:
        was = json.load(f).get('source', {}).get('path')
    if was != source:
        sys.exit(f'{out} holds the regions of {was}; give this image its own folder with --out')
os.makedirs(out, exist_ok=True)
for stale in glob.glob(os.path.join(out, '*.u8')) + glob.glob(os.path.join(out, 'check.png')):
    os.remove(stale)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 24), b''):
            h.update(chunk)
    return h.hexdigest()


ckpt = hf_hub_download(REPO, CHECKPOINT)
bpe = os.path.join(os.path.dirname(sam3.__file__), 'assets', 'bpe_simple_vocab_16e6.txt.gz')
cuda = torch.cuda.is_available()
image = Image.open(args.image).convert('RGB')
W, H = image.size
found = []
with torch.autocast('cuda', dtype=torch.bfloat16, enabled=cuda):
    model = build_sam3_image_model(bpe_path=bpe, checkpoint_path=ckpt, load_from_HF=False,
                                   device='cuda' if cuda else 'cpu')
    processor = Sam3Processor(model, confidence_threshold=args.confidence, device='cuda' if cuda else 'cpu')
    state = processor.set_image(image)
    for prompt in args.prompts:
        processor.reset_all_prompts(state)
        state = processor.set_text_prompt(state=state, prompt=prompt)
        masks = state['masks_logits'].float().cpu().numpy()[:, 0]
        for k, score in enumerate(state['scores'].float().cpu().numpy()):
            found.append((prompt, float(score), masks[k]))

# Each label's regions from the highest score: <label>-0, <label>-1, … The id names a file, so it
# keeps only lowercase letters, digits and dashes, and labels that read the same share one count.
def slug(label):
    return re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-') or 'region'


regions, hard, count = [], {}, {}
for prompt, score, soft in sorted(found, key=lambda f: (args.prompts.index(f[0]), -f[1])):
    inside = soft > 0.5
    if inside.sum() < 16:
        continue
    ys, xs = np.nonzero(inside)
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1
    n = count.get(slug(prompt), 0)
    count[slug(prompt)] = n + 1
    rid = f'{slug(prompt)}-{n}'
    weight = np.ascontiguousarray(np.clip(soft[y0:y1, x0:x1], 0, 1))
    (weight * 255).astype(np.uint8).tofile(os.path.join(out, rid + '.u8'))
    hard[rid] = inside
    yy, xx = np.indices(weight.shape)
    cx = x0 + ((xx + 0.5) * weight).sum() / weight.sum()
    cy = y0 + ((yy + 0.5) * weight).sum() / weight.sum()
    regions.append({'id': rid, 'label': prompt, 'score': round(score, 3), 'box': [x0, y0, x1 - x0, y1 - y0],
                    'centre': [round(float(cx), 1), round(float(cy), 1)],
                    'mask': {'file': rid + '.u8', 'dtype': 'u8', 'channels': 1, 'width': x1 - x0,
                             'height': y1 - y0, 'rowStride': x1 - x0, 'at': [x0, y0]}})

for prompt in args.prompts:
    if not any(r['label'] == prompt for r in regions):
        print(f'no region for "{prompt}" at confidence {args.confidence}', file=sys.stderr)

# parent: the smallest other region that holds 90% of this one (counted where their boxes meet)
area = {r['id']: int(hard[r['id']].sum()) for r in regions}


def shared(r, q):
    (ax, ay, aw, ah), (bx, by, bw, bh) = r['box'], q['box']
    x0, y0, x1, y1 = max(ax, bx), max(ay, by), min(ax + aw, bx + bw), min(ay + ah, by + bh)
    if x1 <= x0 or y1 <= y0:
        return 0
    return int((hard[r['id']][y0:y1, x0:x1] & hard[q['id']][y0:y1, x0:x1]).sum())


for r in regions:
    best = None
    for q in regions:
        if q is r or area[q['id']] <= area[r['id']] or (best is not None and area[q['id']] >= area[best['id']]):
            continue
        if shared(r, q) >= 0.9 * area[r['id']]:
            best = q
    if best:
        r['parent'] = best['id']

doc = {'format': 'shaderera.analysis/1', 'kind': 'regions',
       'source': {'path': source, 'bytes': os.path.getsize(args.image),
                  'sha256': sha256(args.image), 'width': W, 'height': H},
       'tool': {'script': 'tools/regions-sam.py', 'model': REPO, 'checkpoint': CHECKPOINT,
                'checkpointSha256': sha256(ckpt), 'licence': 'SAM License', 'sam3': version('sam3'),
                'torch': torch.__version__, 'device': torch.cuda.get_device_name(0) if cuda else 'cpu'},
       'params': {'prompts': args.prompts, 'confidence': args.confidence, 'maskThreshold': 0.5},
       'regions': regions}
with open(os.path.join(out, 'regions.json'), 'w', encoding='utf8') as f:
    json.dump(doc, f, indent=2)
    f.write('\n')

# check.png: every region tinted over the image, its id and score at its box
check = image.convert('RGBA')
colours = [(255, 59, 31), (60, 200, 255), (255, 210, 0), (120, 255, 120), (255, 80, 255), (255, 140, 0)]
for i, r in enumerate(regions):
    c = colours[i % len(colours)]
    tint = Image.new('RGBA', check.size, c + (0,))
    tint.putalpha(Image.fromarray((hard[r['id']] * 110).astype(np.uint8), 'L'))
    check = Image.alpha_composite(check, tint)
for i, r in enumerate(regions):
    c = colours[i % len(colours)]
    draw = ImageDraw.Draw(check)
    x, y, w, h = r['box']
    draw.rectangle([x, y, x + w, y + h], outline=c + (255,), width=max(2, W // 400))
    draw.text((x + 4, y + 4), f"{r['id']} {r['score']}", fill=c + (255,))
check.convert('RGB').save(os.path.join(out, 'check.png'))
print(f"{out}/regions.json: " + ', '.join(f"{r['id']} {r['score']}" for r in regions))
