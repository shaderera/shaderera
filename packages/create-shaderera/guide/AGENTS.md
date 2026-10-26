# For agents working in this project

This is a Shaderera project: the film is `render(t)` in `src/`, with metadata in
`shaderera.json`. It starts empty, and every frame of it is the film's own code.

- Before creating or revising the film, read `AUTHORING.md` (the workflow, renderers and hosts,
  the checks) and `README.md` (this project's ids, params and requirements). The reference is in
  `node_modules/shaderera/docs/`.
- How the film looks comes from the brief and the person. Shaderera has no house style; do not
  bring one.
- Write the film's code yourself. `AUTHORING.md` ("Plugins") lists what is on the shelf:
  - a **plumbing** plugin may be added instead of writing the same plumbing again (say so in your
    summary);
  - **looks, motion and sound design** plugins only when the person asks.
  Never search for plugins or suggest them on your own. The `shaderera-plugins` skill says how to
  add. If a command refuses the project because a required package plugin is missing, take one of
  the two ways out it names; never work around it silently.
- The skills (`shaderera`, `shaderera-plugins`) come from the Claude Code plugin
  (`claude plugin install shaderera@shaderera`) or, in another agent,
  `npx skills add shaderera/shaderera`. The project holds no copy of them.
- Keep explicit instructions over defaults. If the brief names a real product, logo or brand asset
  and its model or files are missing, ask for them; never present a primitive as the real thing.
  If the brief asks for an original design, or nobody can answer, design an original object or
  mark openly and say so.
- Make the smallest change that does what was asked, to the value that was named, and leave the
  rest of the file as it is, including edits made by hand.
- Keep `render(t)` a function of `t`; run `npx shaderera check` after an edit, and compare the
  frames the change should affect with the ones it should not.
- Look at the frames, not only the numbers: `npx shaderera still <t>... --sheet`, a detail with
  `--region x,y,w,h --scale 8`, or the MCP server (`npx shaderera mcp`, `render_frame` with
  `image: true`). Read motion as a curve: `npx shaderera inspect --track <path>`.
- Build it so it renders fast (`AUTHORING.md`, "Expensive films" and "Footage and stills on the
  GPU"):
  - do decoding, baking and other one-off work in `open`, not in `render(t)`;
  - put footage and stills on GPU textures and sample them in WGSL, a still once and a footage
    frame once a frame; keep Canvas2D for type and small shapes, and never do per-pixel work in
    JS at every frame;
  - trim footage with a short GOP (`guides/footage.md`): every seek decodes from the last
    keyframe.
- While you iterate, look at the frames a change touched, and render only the shot that changed
  (`render --from <s> --to <s> --out out/shot.mp4`). Render the whole film when the person asks,
  in the background with `--progress`, and tell them the time left (`guides/review.md`).
- Renders pile up in `out/` and revisions in `versions/`: delete the renders nobody needs, and
  `npx shaderera prune --dry-run` shows the revisions it can remove.
- Add `--json` to any command for one envelope to read: `ok`, `exitCode` (0 passed, 1 the film
  failed a check, 2 the command could not run) and `findings` with t, file:line and bbox. When
  something on the machine is missing, `npx shaderera doctor` says what and how to fix it.
- Sharing on shaderera.com (`npx shaderera share`) sends the project's source, so it needs a
  licence: `package.json` starts as `"license": "UNLICENSED"` (all rights reserved). Ask the
  person which licence they want before you change it, and run `npx shaderera share --dry-run`
  first. The `shaderera` skill covers `login`, `share`, `fork` and `studio`.
- Comments the person leaves in the studio: the `shaderera` skill's "Working with the person in
  the studio" says how to wait for them, fix them and reply.
- Report what you could not verify by looking: numbers such as contrast or a passing check do not
  establish that a frame looks good.
