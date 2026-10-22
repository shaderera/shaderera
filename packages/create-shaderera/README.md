# create-shaderera

```bash
npm create shaderera@latest my-film
```

Makes an empty Shaderera project that is set up correctly:
- `render(t)` in `src/composition.ts`, which clears a frame on the host's GPU and draws nothing
  else;
- `shaderera.json` (1920×1080, 60 fps, 10 s);
- `webgpu` (Dawn 0.6.2, the version Shaderera is tested against) as its only renderer dependency;
- `AUTHORING.md`, the workflow for making and revising a film;
- `guides/`, focused references for type, 3D products, photos, logos, sound, formats, revisions,
  review and delivery;
- `AGENTS.md` / `CLAUDE.md`, which point agents to them;
- `.mcp.json`, Shaderera's MCP server for agents that read one;
- `package.json` with `"license": "UNLICENSED"` (all rights reserved) until you choose a licence,
  which `shaderera share` needs.

The agent skills are not copied in: the Claude Code plugin installs them in Claude Code, and
`npx skills add shaderera/shaderera` in other agents, so there is one copy to update.

There is no starter film and no house style (decision 0011): how the film looks is your code, in
WGSL, three.js, Canvas2D or any library.

Then `npm install`, `npx shaderera check` and `npx shaderera still 0 5 --sheet`. The reference
is in `node_modules/shaderera/docs/`.

MIT.
