The shots of a video that show a picture already seen, a crop, zoom or pan of it counting as the same picture, read as data.

```sh
python tools/review-shots.py footage/ad.mp4                    # first: shots/ad/shots.json
python tools/review-picture-reuse.py shots/ad/shots.json       # then: shots/ad/picture-reuse.json
```

```json
{ "id": "picture-1", "shots": [{ "id": "shot-1", "start": 0.0 }, { "id": "shot-3", "start": 2.0 }] }
```

It finds repeats only: whether a film may show a picture twice is the reader's call. It checks a
"no repeated pictures" rule on your own renders, and counts how often a reference shows a picture
again.

**The data.** `picture-reuse.json` is a `shaderera.analysis/1` artifact (see `docs/analysis.md` in
the `shaderera` package) of kind `picture-reuse`, beside the shots it read (`--out` writes it
elsewhere). `source` names the video with its bytes and sha256, as the shots have them, and
`shots` the shots file; `tool` the versions, `params` every setting.
- `groups`: each picture shown by more than one shot, numbered from `picture-1` in order of first
  use, with its shots' ids and starts, in order.
- `summary`: `shots`; `shotsWithPicture` (a near-flat shot, black or a plain card, has none);
  `pictures`, the distinct ones; `shotsPerPicture`; `repeatShare`, the share of those shots that
  repeat a picture; `adjacentRepeats`, a picture shown again right after itself (a cut-in);
  `returns`, a picture shown again after other shots, and `returnsPerMinute`; `returnGapMedian`
  and `returnGapP25`, the seconds between a picture's last use and its return (`null` with no
  returns); `maxUses`; `uses`, how many pictures are shown once, twice….

**How it compares.** It takes each shot's middle frame, away from its transitions, at `--width`
pixels wide (640), and finds `--features` ORB features in it (800); a frame with fewer than
`--min-features` (60) has no picture. Two shots show one picture when at least `--matches` (25)
features match, each `--ratio` (0.75) closer than its next best, and fit one homography under
RANSAC within `--reprojection` pixels (6). Shots that match, directly or through another, are
one picture.

Run it from the project root, after `review-shots` (it requires that plugin). It refuses shots
measured from other bytes than the video has now: measure the shots again first. It decodes the
video once, on the CPU, and compares every pair of shots.

Needs Python 3.10+ with OpenCV and numpy, which `review-shots` already installs:
`pip install opencv-python-headless numpy`.
Tested with OpenCV 5.0 and numpy 2.5.

One frame stands for each shot, so a shot whose picture changes (a long pan across a scene, a
dissolve) is matched by its middle only. A flat picture with few features (a gradient, a logo on a
plain ground) is left out, and two different pictures of one repeated pattern can read as one.
