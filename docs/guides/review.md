# Reviewing a draft

Before you call a draft finished, look at it and check it.

1. Run review: MCP `review` (it returns the checks, the contact sheet and the principal frames as
   images) or `npx shaderera review`. Fix every failing check that is yours to fix. Errors always
   fail (determinism, readback, missing glyphs, assets, a caption no export accepts); craft rules
   (end hold, reading time, text overlap, blank frames, safe area, caption limits) fail only when
   requirements.json declares them, and are otherwise measured as info for you to judge against
   the brief. The `captions` check measures the subtitle sidecar: characters per second, duration,
   gap, lines and longest line (in grapheme clusters) and overlaps; declare limits in
   requirements.json `captions` (`maxCps`, `maxLineChars`, `maxLines`, `minDuration`, `minGap`)
   when the placement sets them.
2. Look at the moments the brief cares about, and at least one transition, at full size:
   `npx shaderera still <t>... --sheet`, or MCP `render_frame` with `image: true` and
   `final: true`. Compare each one with the brief and with what the person asked for, not with a
   house style.
3. Check timing with numbers, not by looking: declare the moments that matter in
   requirements.json `timing` and read curves with `npx shaderera inspect --track`. Vision models
   judge fine-grained motion poorly (MotionBench, CVPR 2025).
4. Repair what you see, then review again. Two repair rounds at most: then stop and list what is
   still weak, honestly, in the `weaknesses` of your summary. An agent grading its own work skews
   positive; a separate reviewer with criteria from the brief is stricter (Anthropic, "Harness
   design for long-running apps", 2026-03-24).

While you iterate, look before you render. Look at the frames a change touched (MCP `still` or
`render_frame`, or `npx shaderera still <t>... --sheet`). When you need to see it move, render
only the shot that changed: `npx shaderera render --from <s> --to <s> --out out/shot.mp4`. Render
the whole film when the person asks for it, or for a review round.

Say how long a full render will take. Run it in the background with `--progress`, read the first
progress lines (`frame 120/600  23.4 fps  0:20 left`) and tell the person the time left. Don't
wait in silence. When a render is slow, say why and what helps, in this order:

- A software GPU. `render` refuses it unless `--software-gpu`; `npx shaderera doctor` says what
  to check.
- Footage or stills drawn through Canvas2D, which costs CPU work on every frame.
- Long-GOP footage (few keyframes): reaching a frame decodes every frame since the last keyframe.
  Encode it again with more keyframes.

Keep `--workers` at its default: more hosts don't help a film that waits on its footage.

Numbers are diagnostics: contrast, exposure and motion measurements do not decide whether a dark
frame or a pause is wrong. A passing check never means the film looks good.
