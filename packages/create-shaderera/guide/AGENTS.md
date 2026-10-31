# For agents working in this project

This is a Shaderera project: the film is `render(t)` in `src/`, with metadata in
`shaderera.json`. It starts empty, and every frame of it is the film's own code.

- Before creating or revising the film, read `AUTHORING.md` (the workflow, renderers and hosts,
  the checks, which plugins you may add) and `README.md` (this project's ids, params and
  requirements). The reference is in `node_modules/shaderera/docs/`, and `guides/` holds the
  task checklists (`guides/speed.md` for a film that must render fast).
- The loop (edit, check, look, save), rendering, the studio and sharing are in the `shaderera`
  skill. The skills (`shaderera`, `shaderera-plugins`) come from the Claude Code plugin
  (`claude plugin install shaderera@shaderera`) or, in another agent,
  `npx skills add shaderera/shaderera`. The project holds no copy of them.
- How the film looks comes from the brief and the person. Shaderera has no house style; do not
  bring one. Keep explicit instructions over defaults.
- If the brief names a real product, logo or brand asset and its model or files are missing, ask
  for them; never present a primitive as the real thing. If the brief asks for an original
  design, or nobody can answer, design an original object or mark openly and say so.
- Make the smallest change that does what was asked, to the value that was named, and leave the
  rest of the file as it is, including edits made by hand.
- Never delete `out/`, `versions/` or jobs without asking; `npx shaderera prune --dry-run` shows
  what could be freed. When something on the machine is missing, `npx shaderera doctor` says what.
- Report what you could not verify by looking: numbers such as contrast or a passing check do not
  establish that a frame looks good.
