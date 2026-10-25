# Shaderera docs

Shaderera 0.1.7. A film is `render(t)` in a project; the terms are defined in
[GLOSSARY.md](../GLOSSARY.md).

## Reference

These ship in the `shaderera` package, so an installed project reads them in
`node_modules/shaderera/docs/`.

- [protocol.md](protocol.md): `render(t)`, frames and layers, `shaderera.json`, compositions and
  every capability (inspect, source stamps, pick, camera, audio, captions, depth).
- [determinism.md](determinism.md): what a host promises frame by frame, sequential sources and
  checkpoints, and where project code runs.
- [authoring.md](authoring.md): the working loop for making and revising a film (every project
  gets it as `AUTHORING.md`).
- [cli.md](cli.md): every command, its flags, exit codes and the `--json` envelope.
- [plugins.md](plugins.md): searching, adding, removing and publishing plugins, where they come
  from, and the label.
- [plugin-guide.md](plugin-guide.md): writing a plugin: the label, naming, the rules its code
  follows, versions, testing, the preview, and hosting a library of your own.
- [mcp.md](mcp.md): the same operations as MCP tools for agents.
- [delivery.md](delivery.md): mp4, ProRes, stems, captions, PNG + WAV, batches, placements,
  broadcast, several machines, handoffs.
- [analysis.md](analysis.md): footage and sound as frozen data a film reacts to.
- [player.md](player.md): the web player `share` builds, how a site serves and frames it, and its
  bridge's messages.
- [studio.md](studio.md): `shaderera studio`, the local bridge of the studio page: pairing, the
  bridge's routes (comments, activity, versions), the relay fallback and telemetry (protocol v2).
- [api.md](api.md): what each package exports, and how stable it is.
- [licences.md](licences.md): what the packages depend on and vendor.
- Participants, one per technology: [Canvas2D](participants/canvas.md) ·
  [three.js](participants/three.md) · [Glyph](participants/glyph.md) ·
  [WebGPU](participants/webgpu.md) · [DOM](participants/dom.md)
- [guides/](guides/): task checklists every project gets (typography, formats and delivery,
  revisions, review, sound, identity, photo, 3D product, footage from outside, fast-compiling
  shaders).

## This repository

- [adr/](adr/): recorded decisions.
- [research/](research/README.md): the evidence behind them.
- [releasing.md](releasing.md): how a release is checked.
- [agents/](agents/): issue tracker, triage labels and domain docs for agents working here.
- The official plugins: [packages/plugins/](../packages/plugins/README.md).
