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

## Takes
For a request like "3 takes of 0:45–0:50": a few versions of one moment, one of which the person
picks. In the studio it is a comment on a range that asks for takes; in chat, file it first with
`comment_add {t, to, text}`, so the takes have a comment to belong to.

1. **Start from the tree they saw.** Save it (MCP `save`); its id is the parent. N is what they
   asked for (3 when they didn't say), at most 10.
2. **Make each take**, n = 1 to N:
   - Change one choice, and name it: when the title lands, how the camera moves, which colour.
     Takes that differ only in a random seed are not takes.
   - Change only inside the range. Check that the frames 1 s outside it are untouched:
     `render_frame` at `from - 1` and `to + 1` before and after give the same `sha256`.
   - `check`, then `save {label: "take <n> <comment id>: <the choice, in a few words>"}`. The
     studio finds a comment's takes by this label and plays them side by side.
   - `restore` the parent before the next take.
3. **Reply once**, without `fixed`: "3 takes: 1 lands early, 2 lands on the beat, 3 slides in
   from the left". Leave the tree on the parent.
4. **The person picks.** Their reply names a take ("take 2"). `restore` that take's revision,
   then reply `fixed: true` saying which take it is and what it changed.

A take never touches what `requirements.json` locks, as any other change doesn't.
