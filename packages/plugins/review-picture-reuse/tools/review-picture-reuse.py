# An analyser: the shots of a video that show a picture already seen, a crop, zoom or pan of it
# counting as the same picture, read from review-shots' shots.json and written as
# shaderera.analysis/1 picture-reuse beside it. Run once, apart from rendering.
#
#   python tools/review-picture-reuse.py shots/ad/shots.json     # shots/ad/picture-reuse.json
#   python tools/review-picture-reuse.py shots/ad/shots.json --matches 40
#
# Needs Python 3.10+ with OpenCV and numpy: pip install opencv-python-headless numpy (see the README).
import argparse, hashlib, json, os, sys

import cv2
import numpy as np

ap = argparse.ArgumentParser(description="The shots of a video that show a picture already seen, from review-shots' shots.json")
ap.add_argument('shots', help="review-shots' shots.json")
ap.add_argument('--out', help='the file to write (default picture-reuse.json beside the shots)')
ap.add_argument('--width', type=int, default=640, help='the width the frames are compared at')
ap.add_argument('--features', type=int, default=800, help='ORB features found in each frame')
ap.add_argument('--min-features', type=int, default=60, help='a frame with fewer (black, a plain card) has no picture')
ap.add_argument('--ratio', type=float, default=0.75, help="Lowe's ratio test: a match must be this much closer than the next")
ap.add_argument('--matches', type=int, default=25, help='two frames show one picture with this many matches that fit one homography')
ap.add_argument('--reprojection', type=float, default=6.0, help="RANSAC's reprojection threshold, in pixels at --width")
args = ap.parse_args()
out = args.out or os.path.join(os.path.dirname(args.shots), 'picture-reuse.json')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 24), b''):
            h.update(chunk)
    return h.hexdigest()


# The shots, and the video they were measured from, as it is now.
with open(args.shots, encoding='utf8') as f:
    doc = json.load(f)
if doc.get('format') != 'shaderera.analysis/1' or doc.get('kind') != 'shots':
    sys.exit(f"{args.shots} is not review-shots' shots.json")
source = doc['source']
if not os.path.exists(source['path']):
    sys.exit(f"{source['path']}, the video {args.shots} measured, is missing: run from the project root")
if os.path.getsize(source['path']) != source['bytes'] or sha256(source['path']) != source['sha256']:
    sys.exit(f"{args.shots} was measured from other bytes than {source['path']} has now: run review-shots again")
shots = doc['shots']

orb = cv2.ORB_create(args.features)


def features(frame):
    """A frame's ORB features, or None when it is near flat (black, a plain card): no picture."""
    h, w = frame.shape[:2]
    grey = cv2.cvtColor(cv2.resize(frame, (args.width, round(h * args.width / w)), interpolation=cv2.INTER_AREA),
                        cv2.COLOR_BGR2GRAY)
    points, des = orb.detectAndCompute(grey, None)
    return (points, des) if des is not None and len(points) >= args.min_features else None


# Each shot's middle frame, away from its transitions, in one decode: the frame nearest the middle
# of its time, the earlier on a tie (shots.json's times are rounded to the millisecond).
middles = [(s['start'] + s['end']) / 2 for s in shots]
cap = cv2.VideoCapture(source['path'])
feats, k, prev = [None] * len(shots), 0, None
while k < len(shots) and cap.grab():
    t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
    _, frame = cap.retrieve()
    while k < len(shots) and t >= middles[k]:
        nearer = prev is not None and middles[k] - prev[0] <= t - middles[k] + 0.001
        feats[k] = features(prev[1] if nearer else frame)
        k += 1
    prev = (t, frame)
if prev is None:
    sys.exit(f"{source['path']}: no frames could be read")
for k in range(k, len(shots)):  # a last shot one frame long has its middle after the last frame
    feats[k] = features(prev[1])

matcher = cv2.BFMatcher(cv2.NORM_HAMMING)


def same(a, b):
    """One picture: enough ratio-tested ORB matches that fit one homography (a crop, zoom or pan)."""
    (pa, da), (pb, db) = a, b
    good = [m[0] for m in matcher.knnMatch(da, db, k=2) if len(m) == 2 and m[0].distance < args.ratio * m[1].distance]
    if len(good) < args.matches:
        return False
    H, inliers = cv2.findHomography(np.float32([pa[m.queryIdx].pt for m in good]),
                                    np.float32([pb[m.trainIdx].pt for m in good]), cv2.RANSAC, args.reprojection)
    return H is not None and int(inliers.sum()) >= args.matches


# The shots that show one picture, grouped (union-find), in order of first use.
parent = list(range(len(shots)))


def find(i):
    while parent[i] != i:
        parent[i] = parent[parent[i]]
        i = parent[i]
    return i


for i in range(len(shots)):
    for j in range(i + 1, len(shots)):
        if feats[i] is not None and feats[j] is not None and find(i) != find(j) and same(feats[i], feats[j]):
            parent[find(j)] = find(i)
groups = {}
for i in range(len(shots)):
    if feats[i] is not None:
        groups.setdefault(find(i), []).append(i)
groups = list(groups.values())

# A use right after the last is a cut-in on the same picture; one after other shots is a return.
adjacent, gaps = 0, []
for g in groups:
    for a, b in zip(g, g[1:]):
        if b == a + 1:
            adjacent += 1
        else:
            gaps.append(shots[b]['start'] - shots[a]['end'])
seen = sum(len(g) for g in groups)
minutes = (shots[-1]['end'] - shots[0]['start']) / 60
uses = sorted({len(g) for g in groups})
summary = {
    'shots': len(shots),
    'shotsWithPicture': seen,
    'pictures': len(groups),
    'shotsPerPicture': round(seen / max(1, len(groups)), 2),
    'repeatShare': round(1 - len(groups) / max(1, seen), 3),
    'adjacentRepeats': adjacent,
    'returns': len(gaps),
    'returnsPerMinute': round(len(gaps) / minutes, 2) if minutes > 0 else None,
    'returnGapMedian': round(float(np.median(gaps)), 2) if gaps else None,
    'returnGapP25': round(float(np.percentile(gaps, 25)), 2) if gaps else None,
    'maxUses': max(uses, default=0),
    'uses': {str(n): sum(1 for g in groups if len(g) == n) for n in uses},
}

result = {'format': 'shaderera.analysis/1', 'kind': 'picture-reuse',
          'source': {'path': source['path'], 'bytes': source['bytes'], 'sha256': source['sha256'],
                     'shots': {'path': os.path.relpath(args.shots).replace('\\', '/'),
                               'bytes': os.path.getsize(args.shots), 'sha256': sha256(args.shots)}},
          'tool': {'script': 'tools/review-picture-reuse.py', 'python': sys.version.split()[0],
                   'opencv': cv2.__version__, 'numpy': np.__version__},
          'params': {'width': args.width, 'features': args.features, 'minFeatures': args.min_features,
                     'ratio': args.ratio, 'matches': args.matches, 'reprojection': args.reprojection},
          'summary': summary,
          'groups': [{'id': f'picture-{n + 1}', 'shots': [{'id': shots[i]['id'], 'start': shots[i]['start']} for i in g]}
                     for n, g in enumerate(g for g in groups if len(g) > 1)]}
os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
with open(out, 'w', encoding='utf8') as f:
    json.dump(result, f, indent=2)
    f.write('\n')
print(f"{out}: {len(shots)} shots, {len(groups)} pictures, {summary['returns']} returns")
