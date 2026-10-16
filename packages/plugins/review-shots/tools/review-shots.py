# An analyser: any video measured shot by shot (where it cuts, how the camera moves, the levels
# and the colour), written as shaderera.analysis/1 shots beside contact sheets of one frame a shot.
# Run once, apart from rendering.
#
#   python tools/review-shots.py footage/ad.mp4                     # shots/ad/shots.json, sheet-1.jpg…
#   python tools/review-shots.py footage/ad.mp4 --out shots/ad-v2 --content-threshold 22
#
# Needs Python 3.10+ with PySceneDetect 0.7+ and OpenCV: pip install "scenedetect>=0.7" numpy (see the README).
import argparse, glob, hashlib, json, os, sys
from collections import deque
from importlib.metadata import version

import cv2
import numpy as np
from scenedetect import SceneManager, open_video
from scenedetect.detectors import AdaptiveDetector, ContentDetector

ap = argparse.ArgumentParser(description='A video measured shot by shot: cuts, camera move, levels, colour')
ap.add_argument('video')
ap.add_argument('--out', help='the folder to write (default shots/<video name>)')
ap.add_argument('--adaptive-threshold', type=float, default=2.5, help="PySceneDetect's adaptive detector: hard cuts")
ap.add_argument('--content-threshold', type=float, default=27, help="PySceneDetect's content detector: softer cuts")
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


# Cuts found: the union of the adaptive detector (hard cuts) and the content detector (softer
# ones), as frame numbers.
video = open_video(args.video)
manager = SceneManager()
manager.add_detector(AdaptiveDetector(adaptive_threshold=args.adaptive_threshold, min_scene_len=args.min_shot))
manager.add_detector(ContentDetector(threshold=args.content_threshold, min_scene_len=args.min_shot))
frames = manager.detect_scenes(video)
shortest = max(1, round(args.min_shot * video.frame_rate))
candidates = sorted({s[0].frame_num for s in manager.get_scene_list()} - {0})
bounds = [0] + candidates + [frames]
middles = {(a + b) // 2 for a, b in zip(bounds, bounds[1:])}

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


def usable(m):
    return m is not None and m[3] >= 1 / 3


times, levels, steps, hops, thumbs = [], [], [], [], {}
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
    if len(times) - 1 in middles:
        thumbs[len(times) - 1] = small
    recent.append((grey, cv2.goodFeaturesToTrack(grey, 400, 0.01, 8)))
n = len(times)
if n == 0:
    sys.exit(f'{args.video}: no frames could be read')
step = float(np.median(np.diff(times))) if n > 1 else 1 / (cap.get(cv2.CAP_PROP_FPS) or 30)
times.append(times[-1] + step)
# Each cut found moves to the frame within 2 of it where the picture stops going on (the fewest
# points carried, the nearest on a tie): a flash is found at its edges. Then two cuts closer than
# the shortest shot are one.
cuts = []
for c in candidates:
    c = min(range(max(1, c - 2), min(n, c + 3)), key=lambda i: (steps[i][3] if steps[i] else 0, abs(i - c)))
    if c - (cuts[-1] if cuts else 0) >= shortest:
        cuts.append(c)
bounds = [0] + cuts + [n]
levels = np.array(levels)

# Each shot's move: the transforms from its first frame to its last, chained back from the last in
# hops of HOP frames (in single frames where a hop lost the picture, carrying under a third of its
# points, and over the rest), over the time they span: the move as the viewer sees it, a hold at
# the end included. A frame the flow lost (a flash, black) is left out, its time too. Pan is the
# camera's own direction, against the picture's: x right, y down, in frame widths a second.
shots = []
for k, (a, b) in enumerate(zip(bounds, bounds[1:])):
    move = zoom = pan = None
    total, span, j = np.zeros(3), 0.0, b - 1
    while b - a >= 4 and j > a:
        m, back = (hops[j], HOP) if j - HOP >= a and usable(hops[j]) else (steps[j], 1)
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
                'scenedetect': version('scenedetect'), 'numpy': np.__version__},
       'params': {'adaptiveThreshold': args.adaptive_threshold, 'contentThreshold': args.content_threshold,
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
