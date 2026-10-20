# Decisions

One file per decision, in the order they were made.

- [0002](0002-webgpu-in-node-is-the-projects-dependency.md): WebGPU in Node comes from the
  project's own `webgpu` package, not from `shaderera`.
- [0003](0003-variants-revisions-and-jobs.md): variants in the manifest; saved revisions and
  frozen render jobs above the protocol.
- [0006](0006-browser-host-and-dom.md): a browser host beside the Node host, the project's DOM,
  and depth.
- [0007](0007-gpu-first-host.md): the host composites on the GPU, and export runs on several
  hosts at once.
- [0008](0008-core-extensions-and-catalog.md): core, extensions and the catalog of registry
  items.
- [0009](0009-no-camera-model-in-core.md): core has no camera model, only a matrices hook.
- [0010](0010-engine-licence-and-public-history.md): the engine's licence, and a fresh history in
  public (its licence part is superseded by 0013).
- [0011](0011-experts-and-agents-no-taste-lock.md): for experts and their agents, with no house
  style.
- [0012](0012-delivery-and-agent-tooling.md): delivery and agent tooling for professionals.
- [0013](0013-the-engine-is-mit.md): the engine is MIT, and the name stays the project's.
- [0014](0014-plugins-in-one-cli.md): plugins, one word and one CLI (supersedes 0008's
  `shaderera-registry` CLI and its words).
- [0015](0015-sequential-lookback.md): a sequential source may declare its lookback.
- [0016](0016-bakes.md): bakes, frames made outside the host, declared, stamped and refused
  when stale; and what was decided not to build yet.
- [0017](0017-outside-media.md): outside media, a provenance record per file and a guide to
  finding them, not a skill.
- [0018](0018-hearing-with-clap.md): hearing with CLAP in Node, and `audio-listen` built
  before a film proved it.
- [0019](0019-templates-on-shaderera-com.md): templates on shaderera.com, each showing its source,
  while the engine stays for experts; forking is a command of the one CLI.
- [0020](0020-films-not-templates.md): films, not templates, on shaderera.com; a forkable film
  is one shared with its source (amends 0019).
- [0021](0021-studio-drives-the-local-cli.md): the studio is a page on shaderera.com that drives
  the person's local CLI; code reaches the site only when they share.

0001, 0004 and 0005 were withdrawn before 0.1.0: they described things that no longer exist.
