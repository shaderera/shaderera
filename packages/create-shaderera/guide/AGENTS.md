# For agents working in this project

This is a Shaderera project: the film is `render(t)` in `src/`, with metadata in
`shaderera.json`. It starts empty, and every frame of it is the film's own code.

- Before creating or revising the film, read `AUTHORING.md` (the workflow, renderers and hosts,
  the checks) and `README.md` (this project's ids, params and requirements). The reference is in
  `node_modules/shaderera/docs/`.
- How the film looks comes from the brief and the person. Shaderera has no house style; do not
  bring one.
- Write the film's code yourself. `AUTHORING.md` ("The registry") lists what is on the shelf:
  - a **plumbing** item may be added instead of writing the same plumbing again (say so in your
    summary);
  - **looks, motion and sound design** items only when the person asks.
  Never search the registry or suggest items on your own. The `shaderera-registry` skill says
  how to add: it is in `.claude/skills/shaderera-registry/`, or in `.agents/skills/` for an agent
  that installed it with `npx skills add`. If a command refuses the project because a required
  extension is missing, take one of the three ways out it names; never work around it silently.
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
- Add `--json` to any command for one envelope to read: `ok`, `exitCode` (0 passed, 1 the film
  failed a check, 2 the command could not run) and `findings` with t, file:line and bbox. When
  something on the machine is missing, `npx shaderera doctor` says what and how to fix it.
- Report what you could not verify by looking: numbers such as contrast or a passing check do not
  establish that a frame looks good.
