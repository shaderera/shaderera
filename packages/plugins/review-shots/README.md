Any video measured shot by shot, read as data: where it cuts, how the picture moves, its levels and its colour, with contact sheets of one frame a shot.

```sh
python tools/review-shots.py footage/ad.mp4                  # once: shots/ad/shots.json and sheet-1.jpg…
python tools/review-shots.py footage/ad.mp4 --out shots/ad-v2 --content-threshold 22
```

```json
{ "id": "shot-2", "start": 1.0, "end": 2.5, "zoom": 14.96, "pan": [-0.0002, -0.0001], "move": ["push"],
  "black": 46.6, "white": 145.0, "luma": 95.7, "contrast": 24.0, "saturation": 167.3, "labA": -21.28, "labB": 36.15 }
```

It gives measurements only: what a reference's pacing or grade means for a film is the reader's
call.

**The data.** `shots/<video>/shots.json` is a `shaderera.analysis/1` artifact (see
`docs/analysis.md` in the `shaderera` package) of kind `shots`. `source` names the video with its
bytes and sha256, `tool` the versions, `params` every setting. It is read by people and agents, not
by a film: nothing checks the hash for you, so when the video changes, measure it again. Each shot,
in order, numbered from `shot-1`:
- `start` and `end` in seconds of source time (the decoder's time for each frame); the next
  shot's `start` is a cut, the first frame on which the new shot shows;
- `zoom` is how fast the whole picture grows, in % a second compounded (negative pulls); `pan` is
  `[x, y]`, how fast the view moves over it, in frame widths a second, x right and y down. Both
  run from the shot's first frame to its last, so an eased push that holds at the end counts its
  hold. That is the move as the viewer sees it, made by an editor on a still or by the camera;
  things moving inside the frame are not a move. `move` is a label read from those numbers: `push` or `pull`
  from `--push` (0.3 % a second), `pan` or `tilt` from `--pan` (0.003 frame widths a second), else
  `static`, as in `["push", "pan"]`. A shot under 4 frames is too short to measure: all three are
  `null`;
- `black` and `white` are the 2nd and 98th percentiles of luma, `luma` its mean and `contrast` its
  standard deviation, in 8-bit values (0–255, Rec. 601 weights on the stored values);
  `saturation` is HSV's (0–255); `labA` (green to red) and `labB` (blue to yellow) are CIE Lab.
  Each is the mean over the shot's frames.

`sheet-1.jpg`, `sheet-2.jpg`… show each shot's middle frame, 48 to a page, with its number, start,
length and move.

**How it measures.** Cuts are found by the union of PySceneDetect's adaptive detector (hard cuts,
`--adaptive-threshold`) and its content detector (softer ones, `--content-threshold`). Each moves
to the frame near it where the picture stops going on, so a flash or a dip is one cut; two cuts
closer than `--min-shot` seconds (0.13: a 4-frame shot stays) are one. The move is optical flow
fitted to a similarity transform (scale and shift) and chained over the shot in hops of 8 frames:
a move of a fraction of a pixel a frame cannot be told apart from a label that holds still over
it. A hop that loses the picture falls back to single frames, and a frame the flow loses (a flash,
black) is left out, its time too. Frames are measured at `--width` pixels wide (480).

The labels' defaults: on stills and footage made with known moves, a still frame and a subject
crossing it read under 0.1 % a second, and the slowest real pushes measured (the references in
the taste-to-plugins film) run 0.7 % a second, so a push starts at 0.3.

**Measured against ground truth.** It is made for hard cuts, the direction of a pan or tilt and the
zoom rate. Gradual transitions are not measured reliably yet (#75): a dissolve is mostly missed,
and a shot next to one reads the other picture too.

The test makes a 23.5 s film from a seed whose every frame is known: hard cuts, three 4-frame shots,
a flash, a dip and a 1 s dissolve; push, pull, pan and tilt on stills; an eased push that holds,
under a label that does not move; an eased zoom to twice the size in 1.2 s; a push over moving
content; a push at 0.5 % a second; and a subject crossing a still frame.

| Measure | Pass | Measured |
|---|---|---|
| Cuts | precision and recall ≥ 98 %, a hard cut within ±1 frame | 15 of 15, none extra; every hard cut on its frame. The dissolve is missed (#75) |
| Flash and dip | inside the transition ±1 frame, never two cuts | one cut each, inside |
| Zoom rate (shots of 1 s or more) | error ≤ 0.2 % a second | largest error 0.07 (3.86 for the eased push's 3.93) |
| Pan and tilt direction | ≥ 95 % | 3 of 3 |
| Subject moving in a still frame | no move | 0.00 % a second, `static` |

On a real film (a 267 s explainer of hard cuts, 0.4 s eased dissolves, art plates with eased
pushes and footage, measured against its edit data):

| Measure | Measured |
|---|---|
| Hard cuts | 73 of 74, all on their frame |
| Dissolves | 3 of 29 (#75) |
| False cuts | 12 of 90, half of them every 5 frames in fast footage converted to 25 fps |
| Zoom rate, each shot with a known zoom cut out alone | 28 of 30 within 0.2 % a second |
| Pan and tilt direction | 4 of 4 |

The two zoom misses: a push on a dark painting while a spotlight closes in on it under a label,
which reads −1.1 for 3.2; and a fast pull out over a wall of prints, cut twice in its middle
(measured as one shot it reads −16.9 for −17.0).

Run it from the project root, on a video inside the project. It refuses a folder that holds
another video's shots, and clears the old sheets before it writes. It decodes the video twice, on
the CPU.

Needs Python 3.10+ with PySceneDetect 0.7 or later, which brings OpenCV:
`pip install "scenedetect>=0.7" numpy`.
Tested with scenedetect 0.7.2, OpenCV 5.0 and numpy 2.5.

It does not name transitions (hard cut, dissolve, whip) or tell footage from moved stills, detect
faces, or listen.
