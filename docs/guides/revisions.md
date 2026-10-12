# Revisions

For a request to change an existing film: "warmer light", "make the ending longer", "change the
headline", a camera key, an entrance time.

## Ground the change
The request comes with the time the person was looking at, the selected object's id, its source
line and values, and the effective params. Start there: inspect the selection, open its source
line, render that frame (MCP `render_frame` with `image: true`).

## Change the least
- A named value (a colour, a time, a camera key, a line of copy) is changed in its literal and
  nowhere else. Do not refactor, rename or reformat around it.
- Keep everything else as it is, including edits the person made by hand.
- Never touch what `requirements.json` locks: files, ids and approved frames stay as they are,
  and time-locked beats stay at their times. A request to change how a locked beat looks (the
  hero camera, warmer light) is allowed as long as the beat stays at its time. If the request
  needs a locked item to change, stop and report the conflict.
- A global request (warmer light, faster pacing) legitimately changes the whole film; say so in
  the summary instead of claiming the rest is untouched.
- A copy change re-checks its own line breaks at the frame where the line is fully shown. Longer
  copy that leaves one word alone on a line, or pushes a line past the safe area, is rebalanced in
  the same change (an explicit break or a narrower measure), not left as a weakness.

## Say what changed
Compare frames before and after the change (`render_frame` returns each frame's `sha256`; or
`npx shaderera still --every 0.5` before and after). Your summary should match: "the headline
beat (2.0–3.0 s) changed; everything else is identical". If your change touched more than
intended, fix it before finishing.
