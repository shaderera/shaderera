# Film

A Shaderera project. The film is `render(t)` in `src/composition.ts`; its size, frame rate,
length, seed, params and formats are in `shaderera.json`.

```bash
npm install
npx shaderera check                 # the same t gives the same frame, in any order
npx shaderera still 0 2.5 5 --sheet # stills of any moment, and a contact sheet (out/stills/)
npx shaderera render                # an mp4 (out/)
```

- `AUTHORING.md`: making and revising a film. `guides/`: focused references.
- `node_modules/shaderera/docs/`: the reference (protocol, determinism, the CLI, delivery).
- `AGENTS.md`: notes for an agent working here.

Rewrite this README for the film once it has a subject: its ids, params, formats and assets.
