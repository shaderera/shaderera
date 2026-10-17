# An analyser: any video measured shot by shot (where it cuts, how the camera moves, the levels
# and the colour), written as shaderera.analysis/1 shots beside contact sheets of one frame a shot.
# Run once, apart from rendering.
#
#   python tools/review-shots.py footage/ad.mp4                     # shots/ad/shots.json, sheet-1.jpg…
#   python tools/review-shots.py footage/ad.mp4 --out shots/ad-v2 --content-threshold 22
#
# Needs Python 3.10+ with PySceneDetect 0.7+ and OpenCV: pip install "scenedetect>=0.7" numpy (see the README).
# The first run downloads TransNet V2's weights (30 MB, MIT, from github.com/soCzech/TransNetV2).
import argparse, glob, hashlib, json, os, sys, urllib.request
from collections import deque
from importlib.metadata import version

import cv2
import numpy as np
from scenedetect import SceneManager, open_video
from scenedetect.detector import SceneDetector
from scenedetect.detectors import AdaptiveDetector, ContentDetector

# TransNet V2's weights, as its authors published them (MIT), at a fixed commit.
TRANSNET = ('https://media.githubusercontent.com/media/soCzech/TransNetV2/'
            '85cef72af9a916bdfd7cc94a670c9cdfbf12d1ed/inference/transnetv2-weights/variables/')
WEIGHTS = {'variables.index': '8b99e28b4ad11372d9a1ad9703298c2e370df14859da4245fdbe818e92dd403f',
           'variables.data-00000-of-00001': 'b8c9dc3eb807583e6215cabee9ca61737b3eb1bceff68418b43bf71459669367'}

ap = argparse.ArgumentParser(description='A video measured shot by shot: cuts, camera move, levels, colour')
ap.add_argument('video')
ap.add_argument('--out', help='the folder to write (default shots/<video name>)')
ap.add_argument('--adaptive-threshold', type=float, default=2.5, help="PySceneDetect's adaptive detector: hard cuts")
ap.add_argument('--content-threshold', type=float, default=27, help="PySceneDetect's content detector: softer cuts")
ap.add_argument('--confirm', type=float, default=0.3,
                help="a detector's cut stands where TransNet V2 gives a transition this likely (or a weaker one where the picture stops going on)")
ap.add_argument('--gradual', type=float, default=0.5,
                help='a transition TransNet V2 alone finds this likely is a cut (its own default)')
ap.add_argument('--weights', default=os.path.join(os.path.expanduser('~'), '.cache', 'shaderera', 'transnetv2'),
                help="the folder holding TransNet V2's weights (downloaded there once)")
ap.add_argument('--min-shot', type=float, default=0.13, help='the shortest shot, in seconds')
ap.add_argument('--width', type=int, default=480, help='the width the frames are measured at')
ap.add_argument('--push', type=float, default=0.3, help='the label push or pull from this many %% a second')
ap.add_argument('--pan', type=float, default=0.003, help='the label pan or tilt from this many frame widths a second')
args = ap.parse_args()
# The analysis names the video by its project path, so it must be inside the project (this folder).
try:
    source = os.path.relpath(os.path.abspath(args.video)).replace('\\', '/')
except ValueError:
    source = '..'
if source == '..' or source.startswith('../'):
    sys.exit(f'{args.video} is outside this project: run from the project root, with the video inside it')
out = args.out or os.path.join('shots', os.path.splitext(os.path.basename(args.video))[0])
old = os.path.join(out, 'shots.json')
if os.path.exists(old):
    with open(old, encoding='utf8') as f:
        was = json.load(f).get('source', {}).get('path')
    if was != source:
        sys.exit(f'{out} holds the shots of {was}; give this video its own folder with --out')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 24), b''):
            h.update(chunk)
    return h.hexdigest()


def weights(folder):
    """TransNet V2's checkpoint in folder, downloaded once and checked against its sha256."""
    os.makedirs(folder, exist_ok=True)
    for name, digest in WEIGHTS.items():
        path = os.path.join(folder, name)
        if os.path.exists(path) and sha256(path) == digest:
            continue
        print(f'downloading TransNet V2 weights into {folder}: {name}', file=sys.stderr)
        try:
            urllib.request.urlretrieve(TRANSNET + name, path + '.part')
        except OSError as e:
            sys.exit(f'could not download the TransNet V2 weights from {TRANSNET}{name}: {e}; '
                     f'download {name} yourself into {folder}, or name another folder with --weights')
        if sha256(path + '.part') != digest:
            sys.exit(f'{TRANSNET}{name} is not the file this tool was measured with (sha256 differs)')
        os.replace(path + '.part', path)
    return os.path.join(folder, 'variables')


# TransNet V2 (Souček and Lokoč, 2020, MIT), a network trained to find shot transitions, hard and
# gradual, run here in numpy from its TensorFlow checkpoint: the checkpoint's table read without
# TensorFlow, then the network as published. Its outputs match TensorFlow's to 1e-6.
def varint(b, i):
    n = s = 0
    while True:
        c = b[i]
        i += 1
        n |= (c & 0x7f) << s
        s += 7
        if c < 0x80:
            return n, i


def proto(b):
    """A protobuf message's fields: {number: [values]}, varints as ints, the rest as bytes."""
    fields, i = {}, 0
    while i < len(b):
        key, i = varint(b, i)
        kind = key & 7
        if kind == 0:
            v, i = varint(b, i)
        elif kind in (1, 5):
            v, i = b[i:i + (8 if kind == 1 else 4)], i + (8 if kind == 1 else 4)
        else:
            size, i = varint(b, i)
            v, i = b[i:i + size], i + size
        fields.setdefault(key >> 3, []).append(v)
    return fields


def entries(b):
    """A table block's (key, value) entries (keys share prefixes; restart points at its end)."""
    restarts = int.from_bytes(b[-4:], 'little')
    end, i, key = len(b) - 4 - 4 * restarts, 0, b''
    while i < end:
        shared, i = varint(b, i)
        own, i = varint(b, i)
        size, i = varint(b, i)
        key = key[:shared] + b[i:i + own]
        yield key, b[i + own:i + own + size]
        i += own + size


def checkpoint(prefix):
    """{name: float32 array} from a TensorFlow checkpoint: its index is a table of tensor entries
    (dtype, shape, offset and size in the data file)."""
    with open(prefix + '.index', 'rb') as f:
        index = f.read()
    with open(prefix + '.data-00000-of-00001', 'rb') as f:
        data = f.read()
    if index[-8:] != bytes.fromhex('57fb808b247547db'):
        sys.exit(f'{prefix}.index is not a TensorFlow checkpoint')
    _, i = varint(index, len(index) - 48)
    _, i = varint(index, i)
    at, i = varint(index, i)
    size, _ = varint(index, i)
    tensors = {}
    for _, handle in entries(index[at:at + size]):
        o, i = varint(handle, 0)
        size, _ = varint(handle, i)
        if index[o + size] != 0:
            sys.exit(f'{prefix}.index: a compressed block, which this reader does not read')
        for name, value in entries(index[o:o + size]):
            e = proto(value)
            if not name or e.get(1, [0])[0] != 1:  # the header, or not float32
                continue
            shape = [proto(d).get(1, [0])[0] for d in proto(e[2][0]).get(2, [])] if 2 in e else []
            tensors[name.decode()] = np.frombuffer(data, np.float32, e.get(5, [0])[0] // 4,
                                                   e.get(4, [0])[0]).reshape(shape)
    return tensors


def relu(x):
    return np.maximum(x, 0, out=x)


def lookup(sim):
    """[B, T, T] similarities to [B, T, 101]: each frame's against the 50 either side, 0 outside."""
    T = sim.shape[1]
    padded = np.pad(sim, ((0, 0), (0, 0), (50, 50)))
    return padded[:, np.arange(T)[:, None], np.arange(T)[:, None] + np.arange(101)]


class TransNetV2:
    def __init__(self, prefix):
        w = checkpoint(prefix)
        v = lambda i: w[f'variables/{i}/.ATTRIBUTES/VARIABLE_VALUE']
        a = lambda name: w[f'{name}/.ATTRIBUTES/VARIABLE_VALUE']
        # Three stacks of two dilated (2+1)D blocks: in each block four branches, a 3×3 conv in
        # space then a 3-tap conv in time dilated 1, 2, 4, 8, then batch norm. The four spatial convs
        # are one matmul; the four temporal ones are one too, each tap's output shifted in time.
        self.blocks = []
        for s in range(6):
            b, m = s * 10, 60 + 2 * s
            spatial = np.concatenate([v(b + 2 * j) for j in range(4)], -1)
            half, f = v(b + 1).shape[3:]
            temporal = np.zeros((4 * half, 4, 3, f), np.float32)
            for j in range(4):
                temporal[j * half:(j + 1) * half, j] = v(b + 2 * j + 1).reshape(3, half, f).transpose(1, 0, 2)
            scale = v(b + 8) / np.sqrt(v(m + 1) + 1e-3)
            self.blocks.append((spatial.reshape(-1, spatial.shape[-1]), temporal.reshape(4 * half, -1),
                                scale, v(b + 9) - v(m) * scale))
        self.fc1 = (a('fc1/kernel'), a('fc1/bias'))
        self.cls = (np.concatenate([a('cls_layer1/kernel'), a('cls_layer2/kernel')], 1),
                    np.concatenate([a('cls_layer1/bias'), a('cls_layer2/bias')]))
        self.similarity = (v(78), v(79), v(80), v(81))
        self.histograms = (v(82), v(83))

    @staticmethod
    def block(x, spatial, temporal, scale, shift, act):
        B, T, H, W, C = x.shape
        p = np.pad(x, ((0, 0), (0, 0), (1, 1), (1, 1), (0, 0)))
        cols = np.concatenate([p[:, :, dy:dy + H, dx:dx + W] for dy in range(3) for dx in range(3)], -1)
        f = temporal.shape[1] // 12
        z = ((cols.reshape(-1, 9 * C) @ spatial) @ temporal).reshape(B, T, H, W, 4, 3, f)
        y = z[..., 1, :].copy()
        for j, d in enumerate((1, 2, 4, 8)):
            y[:, d:, :, :, j] += z[:, :-d, :, :, j, 0]
            y[:, :-d, :, :, j] += z[:, d:, :, :, j, 2]
        y = y.reshape(B, T, H, W, 4 * f)
        y *= scale
        y += shift
        return relu(y) if act else y

    def window(self, frames):
        """[B, 100, 27, 48, 3] uint8 RGB frames to [B, 100] likelihoods that each is in a transition:
        one-hot (its middle frame; a hard cut's last frame of the old shot) and all its frames."""
        x = frames.astype(np.float32) / 255
        means = []
        for k in range(0, 6, 2):
            first = self.block(x, *self.blocks[k], True)
            x = relu(self.block(first, *self.blocks[k + 1], False)) + first
            B, T, H, W, C = x.shape
            x = x[:, :, :H // 2 * 2, :W // 2 * 2].reshape(B, T, H // 2, 2, W // 2, 2, C).mean((3, 5))
            means.append(x.mean((2, 3)))
        B, T = x.shape[:2]
        pw, pb, fw, fb = self.similarity
        f = np.concatenate(means, -1) @ pw + pb
        f /= np.sqrt(np.maximum((f * f).sum(-1, keepdims=True), 1e-12))
        similar = relu(lookup(f @ f.transpose(0, 2, 1)) @ fw + fb)
        q = frames.astype(np.int32) >> 5
        bins = ((q[..., 0] << 6) + (q[..., 1] << 3) + q[..., 2]).reshape(B * T, -1)
        hist = np.stack([np.bincount(b, minlength=512) for b in bins]).astype(np.float32).reshape(B, T, 512)
        hist /= np.sqrt(np.maximum((hist * hist).sum(-1, keepdims=True), 1e-12))
        colour = relu(lookup(hist @ hist.transpose(0, 2, 1)) @ self.histograms[0] + self.histograms[1])
        x = np.concatenate([colour, similar, x.reshape(B, T, -1)], -1)
        x = relu(x @ self.fc1[0] + self.fc1[1]) @ self.cls[0] + self.cls[1]
        return 1 / (1 + np.exp(-x))

    def __call__(self, frames):
        """Every frame's likelihoods, as its authors run it: windows of 100 frames 50 apart, the
        video's ends padded with copies of its first and last frames, each window's middle 50 kept."""
        n = len(frames)
        padded = np.concatenate([frames[:1]] * 25 + [frames] + [frames[-1:]] * (75 - (n % 50 or 50)))
        return np.concatenate([self.window(padded[i:i + 100][None])[0, 25:75] for i in range(0, n, 50)])[:n]


# Cuts found: the union of PySceneDetect's adaptive detector (hard cuts) and its content detector
# (softer ones), as frame numbers, in the same decode as the 48 × 27 frames TransNet V2 reads.
class Frames(SceneDetector):
    def __init__(self):
        super().__init__()
        self.frames = []

    def process_frame(self, timecode, frame_img):
        self.frames.append(cv2.cvtColor(cv2.resize(frame_img, (48, 27), interpolation=cv2.INTER_AREA),
                                        cv2.COLOR_BGR2RGB))
        return []


model = TransNetV2(weights(args.weights))
video = open_video(args.video)
manager = SceneManager()
manager.add_detector(AdaptiveDetector(adaptive_threshold=args.adaptive_threshold, min_scene_len=args.min_shot))
manager.add_detector(ContentDetector(threshold=args.content_threshold, min_scene_len=args.min_shot))
small = Frames()
manager.add_detector(small)
frames = manager.detect_scenes(video)
shortest = max(1, round(args.min_shot * video.frame_rate))
detected = sorted({s[0].frame_num for s in manager.get_scene_list()} - {0})
likely = model(np.array(small.frames)) if small.frames else np.zeros((0, 2))

# TransNet V2's transitions: each run of frames it gives at least 0.1 as a transition's middle or
# 0.5 as one of its frames, with its likeliest middle. A detector's cut that a transition holds (a
# hard cut's likeliest middle is the frame before it) stands from --confirm, and below that only
# where the picture stops going on near it (a flash reads weak). A detector's cut that no transition
# holds is the picture moving fast, not a cut. A transition that holds no detector's cut is a cut on
# the frame after its likeliest middle, from --gradual (dissolves, mostly), unless the picture goes
# on across it (a spotlight, a card laid over it). One cut a transition.
inside = (likely[:, 0] >= 0.1) | (likely[:, 1] >= 0.5)
likely = likely[:, 0]
runs, i = [], 0
while i < len(likely):
    if inside[i]:
        j = i
        while j + 1 < len(likely) and inside[j + 1]:
            j += 1
        top = i + int(np.argmax(likely[i:j + 1]))
        runs.append((i, j, top))
        i = j + 1
    else:
        i += 1
held = {}
for c in detected:
    for r in runs:
        if r[0] <= c + 1 and r[1] >= c - 3 and (r not in held or abs(c - r[2]) < abs(held[r] - r[2])):
            held[r] = c
firm = {c for r, c in held.items() if likely[r[2]] >= args.confirm}
weak = {c for r, c in held.items() if likely[r[2]] < args.confirm}
alone = {r[2] + 1: r for r in runs if r not in held and likely[r[2]] >= args.gradual and r[2] + 1 < frames}
gradual = set(alone)
# The frames 3 beyond each of those, either side, to see whether the picture goes on across it.
around = {f for r in alone.values() for f in (r[0] - 3, r[1] + 3)}
candidates = sorted(firm | weak | gradual)
# The middle of every shot these could make, a weak or a model's cut kept or not, for the sheets.
bounds = [0] + candidates + [frames]
middles = set()
for a, x in enumerate(bounds):
    for y in bounds[a + 1:]:
        middles.add((x + y) // 2)
        if y not in weak | gradual:
            break

# Every frame once, at the measuring width: its time, its levels and colour, the similarity
# transforms that carry the last frame and the frame HOP back onto it, and each shot's middle frame
# for the sheets. A move of a fraction of a pixel a frame cannot be told from a label that holds
# still over it, so the move is read over hops of several frames.
HOP = 8
cap = cv2.VideoCapture(args.video)
W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
w = min(args.width, W)
h = round(H * w / W)


def fit(a, points, b):
    """The similarity transform carrying grey a onto grey b, from a's points: its log scale, how far
    the frame's centre moved (in frame widths) and the share of the points it carries (none: the
    picture did not go on); None when the points are lost."""
    if points is None or len(points) < 12:
        return None
    moved, found, _ = cv2.calcOpticalFlowPyrLK(a, b, points, None, winSize=(21, 21), maxLevel=3)
    good = found.ravel() == 1
    if good.sum() < 10:
        return None
    M, inliers = cv2.estimateAffinePartial2D(points[good], moved[good], method=cv2.RANSAC, ransacReprojThreshold=1.0)
    if M is None:
        return None
    centre = M @ np.array([w / 2, h / 2, 1])
    return (np.log(np.hypot(M[0, 0], M[1, 0])), (centre[0] - w / 2) / w, (centre[1] - h / 2) / w,
            inliers.sum() / len(points))


def flat(grey):
    """Grey with its local brightness and contrast taken out, so a picture lit or dimmed in part (a
    spotlight, a fade) still matches itself."""
    g = grey.astype(np.float32)
    mean = cv2.GaussianBlur(g, (0, 0), 6)
    spread = np.sqrt(cv2.GaussianBlur((g - mean) ** 2, (0, 0), 6))
    return np.clip((g - mean) / (spread + 4) * 40 + 128, 0, 255).astype(np.uint8)


def goes_on(first, last, _):
    """Whether the picture 3 frames before a transition carries a third of its points onto the
    picture 3 frames after it, lighting aside: something laid over it or lit, not a new shot."""
    a, b = around_grey.get(first - 3), around_grey.get(last + 3)
    if a is None or b is None:
        return False
    m = fit(a, cv2.goodFeaturesToTrack(a, 400, 0.01, 8), b)
    return usable(m)


def usable(m):
    return m is not None and m[3] >= 1 / 3


times, levels, steps, hops, thumbs, around_grey = [], [], [], [], {}, {}
recent = deque(maxlen=HOP)  # the last HOP frames' greys and points
while True:
    ok, frame = cap.read()
    if not ok:
        break
    times.append(cap.get(cv2.CAP_PROP_POS_MSEC) / 1000)
    small = cv2.resize(frame, (w, h), interpolation=cv2.INTER_AREA)
    grey = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    lab = cv2.cvtColor(small, cv2.COLOR_BGR2LAB)
    black, white = np.percentile(grey, [2, 98])
    levels.append((black, white, grey.mean(), grey.std(), cv2.cvtColor(small, cv2.COLOR_BGR2HSV)[..., 1].mean(),
                   lab[..., 1].mean() - 128, lab[..., 2].mean() - 128))
    steps.append(fit(*recent[-1], grey) if recent else None)
    hops.append(fit(*recent[0], grey) if len(recent) == HOP else None)
    if len(times) - 1 in around:
        around_grey[len(times) - 1] = flat(grey)
    if len(times) - 1 in middles:
        thumbs[len(times) - 1] = small
    recent.append((grey, cv2.goodFeaturesToTrack(grey, 400, 0.01, 8)))
n = len(times)
if n == 0:
    sys.exit(f'{args.video}: no frames could be read')
step = float(np.median(np.diff(times))) if n > 1 else 1 / (cap.get(cv2.CAP_PROP_FPS) or 30)
times.append(times[-1] + step)
# A weak cut stands where the picture stops going on within 2 frames of it (under a third of the
# points carried), a model's cut where it does not go on across. Each detector's cut moves to the frame within 2 of it where the picture stops
# going on (the fewest points carried, the nearest on a tie): a flash is found at its edges. Then
# two cuts closer than the shortest shot are one.
carried = lambda i: steps[i][3] if i < n and steps[i] else 0
cuts = []
for c in candidates:
    near = range(max(1, c - 2), min(n, c + 3))
    if c in weak and min(map(carried, near), default=0) >= 1 / 3:
        continue
    if c in gradual and goes_on(*alone[c]):
        continue
    if c not in gradual:
        c = min(near, key=lambda i: (carried(i), abs(i - c)))
    if c - (cuts[-1] if cuts else 0) >= shortest:
        cuts.append(c)
bounds = [0] + cuts + [n]
levels = np.array(levels)

# Each shot's move: the transforms from its first frame to its last, chained back from the last in
# hops of HOP frames (in single frames where a hop lost the picture, carrying under a third of its
# points, and over the rest), over the time they span: the move as the viewer sees it, a hold at
# the end included. A frame the flow lost (a flash, black) is left out, its time too, and so are
# the frames of a gradual transition (TransNet V2's run of 3 frames or more around the cut), where
# two pictures show at once. Pan is the camera's own direction, against the picture's: x right, y
# down, in frame widths a second.
def gradual_run(c):
    return next(((r[0], r[1]) for r in runs if r[0] <= c <= r[1] + 1 and r[1] - r[0] >= 2), None)


shots = []
for k, (a, b) in enumerate(zip(bounds, bounds[1:])):
    move = zoom = pan = None
    first, last = gradual_run(a) if a else None, gradual_run(b) if b < n else None
    lo = max(a, first[1] + 1) if first else a
    hi = min(b, last[0]) if last else b
    if hi - lo < 4:
        lo, hi = a, b
    total, span, j = np.zeros(3), 0.0, hi - 1
    while b - a >= 4 and j > lo:
        m, back = (hops[j], HOP) if j - HOP >= lo and usable(hops[j]) else (steps[j], 1)
        if usable(m):
            total += m[:3]
            span += times[j] - times[j - back]
        j -= back
    if span > 0:
        zoom, px, py = (np.exp(total[0] / span) - 1) * 100, -total[1] / span, -total[2] / span
        pan = [round(px, 4) + 0.0, round(py, 4) + 0.0]  # + 0.0: no -0.0
        move = ['push' if zoom > 0 else 'pull'] if abs(zoom) >= args.push else []
        if max(abs(px), abs(py)) >= args.pan:
            move.append('pan' if abs(px) >= abs(py) else 'tilt')
        move = move or ['static']
        zoom = round(zoom, 2) + 0.0
    black, white, luma, contrast, saturation, la, lb = levels[a:b].mean(axis=0)
    shots.append({'id': f'shot-{k + 1}', 'start': round(times[a], 3), 'end': round(times[b], 3),
                  'zoom': zoom, 'pan': pan, 'move': move,
                  'black': round(black, 1), 'white': round(white, 1), 'luma': round(luma, 1),
                  'contrast': round(contrast, 1), 'saturation': round(saturation, 1),
                  'labA': round(la, 2), 'labB': round(lb, 2)})

doc = {'format': 'shaderera.analysis/1', 'kind': 'shots',
       'source': {'path': source, 'bytes': os.path.getsize(args.video), 'sha256': sha256(args.video),
                  'width': W, 'height': H, 'frames': n, 'duration': round(times[-1] - times[0], 3)},
       'tool': {'script': 'tools/review-shots.py', 'python': sys.version.split()[0], 'opencv': cv2.__version__,
                'scenedetect': version('scenedetect'), 'numpy': np.__version__,
                'transnetv2': {'weights': TRANSNET, 'sha256': WEIGHTS}},
       'params': {'adaptiveThreshold': args.adaptive_threshold, 'contentThreshold': args.content_threshold,
                  'confirm': args.confirm, 'gradual': args.gradual,
                  'minShot': args.min_shot, 'width': w, 'push': args.push, 'pan': args.pan},
       'shots': shots}
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, 'shots.json'), 'w', encoding='utf8') as f:
    json.dump(doc, f, indent=2)
    f.write('\n')

# Contact sheets: the middle frame of each shot, 6 × 8 to a page, with its number, start, length
# and move.
for stale in glob.glob(os.path.join(out, 'sheet-*.jpg')):
    os.remove(stale)
cols, rows, tw = 6, 8, 320
th = round(tw * h / w)
for p in range(0, len(shots), cols * rows):
    page = shots[p:p + cols * rows]
    sheet = np.full((((len(page) - 1) // cols + 1) * (th + 22), cols * tw, 3), 20, np.uint8)
    for j, shot in enumerate(page):
        k = p + j
        y, x = j // cols * (th + 22), j % cols * tw
        middle = min(thumbs, key=lambda i: abs(i - (bounds[k] + bounds[k + 1]) // 2))
        sheet[y:y + th, x:x + tw] = cv2.resize(thumbs[middle], (tw, th))
        m, s = divmod(shot['start'], 60)
        label = f"#{k + 1} {int(m)}:{s:04.1f} {shot['end'] - shot['start']:.1f}s {'+'.join(shot['move'] or ['-'])}"
        if {'push', 'pull'} & set(shot['move'] or []):
            label += f" {shot['zoom']:+.1f}%/s"
        cv2.putText(sheet, label, (x + 3, y + th + 15), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (230, 230, 230), 1, cv2.LINE_AA)
    cv2.imwrite(os.path.join(out, f'sheet-{p // (cols * rows) + 1}.jpg'), sheet, [cv2.IMWRITE_JPEG_QUALITY, 85])
print(f'{out}/shots.json: {n} frames, {len(shots)} shots')
