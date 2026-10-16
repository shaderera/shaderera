Any video measured shot by shot, read as data: where it cuts, how the camera moves, its levels and its colour, with contact sheets to check it by eye.

```sh
python tools/review-shots.py footage/ad.mp4                  # once: shots/ad/shots.json and sheet-1.jpg…
python tools/review-shots.py footage/ad.mp4 --out shots/ad-v2 --content-threshold 27
```

```json
{ "id": "shot-1", "start": 1.0, "end": 2.0, "move": ["push"], "zoom": 14.87, "pan": [0.0001, -0.0001],
  "black": 46.6, "white": 145.0, "luma": 95.7, "contrast": 24.0, "saturation": 167.3, "labA": -21.28, "labB": 36.15 }
```

It gives measurements only: what a reference's pacing or grade means for a film is the reader's
call.

**The data.** `shots/<video>/shots.json` is a `shaderera.analysis/1` artifact (see
`docs/analysis.md` in the `shaderera` package) of kind `shots`. `source` names the video with its
bytes and sha256, `tool` the versions, `params` every setting. Each shot, in order:
- `start` and `end` in seconds of source time (the decoder's time for each frame); the next
  shot's `start` is a cut;
- `move` is `["static"]`, or one of `push` and `pull` and one of `pan` and `tilt`
  (`["push", "pan"]`); `zoom` is how much the picture grows in % a second (negative pulls); `pan`
  is `[x, y]`, how fast the camera turns, in frame widths a second, x right and y down. A shot
  under 4 frames is too short to measure: all three are `null`;
- `black` and `white` are the 2nd and 98th percentiles of luma, `luma` its mean and `contrast` its
  standard deviation, in 8-bit values (0–255, Rec. 601 weights on the stored values);
  `saturation` is HSV's (0–255); `labA` (green to red) and `labB` (blue to yellow) are CIE Lab.
  Each is the mean over the shot's frames.

`sheet-1.jpg`, `sheet-2.jpg`… show each shot's middle frame, 48 to a page, with its number, start,
length and move. Look at them before you build on the numbers.

**How it measures.** Cuts are the union of PySceneDetect's adaptive detector (hard cuts,
`--adaptive-threshold`) and its content detector (softer ones, `--content-threshold`); two cuts
closer than `--min-shot` seconds are one. The camera move is optical flow between frames, fitted to
a similarity transform (scale and shift) and summed over the shot, leaving out the two frames after
a cut and the one before the next. A shot is a push or pull from `--push` % a second, a pan or tilt
from `--pan` frame widths a second. Frames are measured at `--width` pixels wide (480).

Run it from the project root, on a video inside the project. It refuses a folder that holds
another video's shots, and clears the old sheets before it writes. It decodes the video twice, on
the CPU.

Needs Python 3.10+ with PySceneDetect 0.7 or later, which brings OpenCV:
`pip install "scenedetect>=0.7" numpy`.
Tested with scenedetect 0.7.2, OpenCV 5.0 and numpy 2.5.

It does not name transitions (hard cut, dissolve, whip) or tell footage from moved stills, detect
faces, or listen. A subject that fills the frame and moves can read as a camera move, and a slow
dissolve may be missed or cut in its middle: the sheets show both.
