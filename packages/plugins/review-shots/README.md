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

**How it measures.** Cuts come from two sources, read together. PySceneDetect's adaptive detector
(hard cuts, `--adaptive-threshold`) and its content detector (softer ones, `--content-threshold`)
find each cut on its frame, but also fire inside fast footage. TransNet V2, a network trained to
find shot transitions, hard and gradual, gives each frame how likely it is the middle of one, and
how likely it is one of its frames; a transition is a run of frames it gives 0.1 or more as a middle
or 0.5 or more as one of its frames.
- A detector's cut stands where a transition holds it: from `--confirm` (0.3), and below that only
  where the picture stops going on within 2 frames of it (under a third of the tracked points
  carried), as at a flash. A detector's cut with no transition there is fast footage, not a cut.
- A transition that holds no detector's cut is a cut on the frame after its likeliest middle, from
  `--gradual` (0.5, TransNet V2's own default): dissolves, mostly. Unless the picture goes on across
  it: when the picture 3 frames before it carries a third of its points onto the picture 3 frames
  after it, brightness and contrast evened out locally first, it is something laid over the picture
  or lit on it, not a new shot.
- A transition is one cut. Each detector's cut then moves to the frame near it where the picture
  stops going on, so a flash or a dip is one cut, and two cuts closer than `--min-shot` seconds
  (0.13: a 4-frame shot stays) are one.

So a hard cut is on its frame, and a dissolve's cut is in its middle: the shot before it ends there.

The move is optical flow fitted to a similarity transform (scale and shift) and chained over the
shot in hops of 8 frames: a move of a fraction of a pixel a frame cannot be told apart from a label
that holds still over it. A hop that loses the picture falls back to single frames, and a frame the
flow loses (a flash, black) is left out, its time too, and so are a dissolve's frames (TransNet
V2's run of 3 frames or more around its cut), where two pictures show at once. Frames are measured
at `--width` pixels wide (480).

The labels' defaults: on stills and footage made with known moves, a still frame and a subject
crossing it read under 0.1 % a second, and the slowest real pushes measured (the references in
the taste-to-plugins film) run 0.7 % a second, so a push starts at 0.3.

**Measured against ground truth.** It is made for hard cuts, dissolves, dips and flashes, the
direction of a pan or tilt and the zoom rate, and finds no cut in fast footage. Not measured
reliably:
- a change over a picture that goes on is not a cut: a card swapped over footage that keeps playing
  (about 15 % of the frame) is not found, nor a dissolve to the same picture under a new title;
- something laid over the picture or lit on it as fast as a cut can still read as one: a spotlight
  switching on, a fade to black at the very end;
- a push on a dark picture while a spotlight closes in under a still label reads too slow (0.9 for
  3.2 % a second): the label takes the tracked points once the picture is dim.

The test makes a 40 s film from a seed whose every frame is known:
- hard cuts, three 4-frame shots, a flash, a dip and a 1 s dissolve between stills;
- eased dissolves of 0.4 and 0.8 s over moving content, one into a still, and a card swapped over
  footage that keeps playing;
- push, pull, pan and tilt on stills; an eased push that holds, under a label that does not move;
  an eased zoom to twice the size in 1.2 s; a push over moving content; a push at 0.5 % a second;
  a subject crossing a still frame;
- the cases that used to read as cuts: a push over dense footage that drops every sixth frame (as
  footage made at 30 fps shown at 25 does), a fast eased pull out over a wall of prints, and a push
  on a dark still while a spotlight closes in under a label.

| Measure | Pass | Measured |
|---|---|---|
| Cuts | precision and recall ≥ 98 %, a hard cut on its frame | all 25 but the card swap's, none extra; every hard cut on its frame |
| Flash, dip and dissolves | inside the transition ±1 frame, never two cuts | one cut each, inside; the card swap missed, never two |
| Zoom rate (shots of 1 s or more) | error ≤ 0.2 % a second | 22 of 23, largest error 0.10 (−37.50 for the fast pull's −37.60); the spotlight push reads 0.90 for 3.20 |
| Pan and tilt direction | ≥ 95 % | 5 of 5 |
| Subject moving in a still frame | no move | 0.00 % a second, `static` |

On a real film (a 267 s explainer of hard cuts, 0.4 s eased dissolves, art plates with eased
pushes and footage, measured against its edit data), before TransNet V2 and with it:

| Measure | Detectors alone | With TransNet V2 |
|---|---|---|
| Hard cuts | 73 of 74, all on their frame | 73 of 74, all on their frame |
| Dissolves | 3 of 29 | 26 of 29 |
| False cuts | 12 of 90, 6 in a fast dolly shot, 2 in a fast pull | 2 of 103 (a spotlight on a card, the end fade) |
| Cuts overall | precision 86.7 %, recall 73.8 % | precision 98.1 %, recall 96.1 % |
| Zoom rate, each shot with a known zoom cut out alone | 28 of 30 within 0.2 % a second | 29 of 30 |
| Zoom rate on the film as cut, each shot of 1 s or more against the truth over its frames | 13 of 23 | 22 of 32 |
| Pan and tilt direction | 4 of 4 | 13 of 13 |

The settings were chosen on the test film and the first half of the real film; its second half
(12 dissolves, a fast dolly, a fast pull) reads recall 100 % and precision 97.8 % (before: 73.3 %
and 78.6 %). The dissolves missed: one TransNet V2 gives 0.09, and two across which the picture
goes on (a card swapped over footage, the same picture under a title). Cut out alone, the zoom
miss is the spotlight push above (−0.6 for 3.2). On the film as cut, most misses are shots that
run on into a missed transition or the end fade, and so read two pictures.

Run it from the project root, on a video inside the project. It refuses a folder that holds
another video's shots, and clears the old sheets before it writes. It decodes the video twice and
runs TransNet V2 in numpy, all on the CPU: on a 10-core i5-14400F the 267 s film above takes 190 s, about
43 s a minute of video (TransNet V2 is about 20 of them; 23 s a minute without it).

Needs Python 3.10+ with PySceneDetect 0.7 or later, which brings OpenCV:
`pip install "scenedetect>=0.7" numpy`.
Tested with scenedetect 0.7.2, OpenCV 5.0 and numpy 2.5.
- TransNet V2 (Tomáš Souček and Jakub Lokoč, 2020) is MIT, code and weights, from
  `https://github.com/soCzech/TransNetV2`. This tool runs its network in numpy from its TensorFlow
  checkpoint, so it needs neither TensorFlow nor PyTorch.
- The weights are your own download, under that MIT licence: the first run fetches the checkpoint
  (30 MB) from that repository at commit `85cef72` into `~/.cache/shaderera/transnetv2`, or the
  folder `--weights` names, and checks its sha256. `shots.json` records where they came from.

It does not name transitions (hard cut, dissolve, whip) or give their length, tell footage from
moved stills, detect faces, or listen.
