# 0003: Variants in the manifest; saved revisions and frozen render jobs above the protocol

**Observed problem.** A preview change (in the Studio, now on hold) reached the browser export but
not the Node export, which rendered the saved defaults (an agency audit). Nothing recorded which source, params
and settings an approved film was rendered from, so "export exactly the version I approved" could
not be promised; an edit made during a long export could mix old and new inputs. Campaign outputs
(9:16, 1:1, a 6 s cutdown) had no declared home: a vertical cut was either a second project or a
crop.

**Existing solutions considered.** A project could use git for history, but many people creating
an ad have no git, and a commit does not freeze params or delivery settings. Remotion stores
render inputs in its CLI flags and composition props; that covers params but not a frozen source.
A creative IR or timeline would freeze everything but is exactly what the architecture rules out.

**Smallest change.**
- `shaderera.json` gains `variants`: named outputs that override width, height, duration or fps
  and may set params. Declarative data, checked by `checkManifest`; `withVariant` applies one. The
  source lays itself out from `host.manifest`, so a variant is a designed output, never a crop.
- `versions/` in the project keeps content-addressed revisions (objects, one JSON per revision, a
  log). The id is the hash of the file list. Save, restore, undo (unsaved edits are saved first),
  diff. (An `apply` step for an agent's staged change went with the agent broker.)
- A render job (`versions/jobs/<name>.json`, `job/2`) freezes a revision, a variant, the complete
  effective params, the seed, the window and delivery settings, with asset and lock hashes and the
  installed packages its source executes, by content. Every host renders a job from the
  revision's frozen copy (`.shaderera/revisions/<id>/`, checked against the revision on every
  use) after checking those packages and the Shaderera version: both hosts through `openJob`, the
  CLI through `render --job`, MCP through `export` with `job`.
- A job's `id` hashes everything it renders with; its `name` is the file. A name never changes
  meaning: different inputs under a taken name are refused unless replaced explicitly, and a job
  or revision edited by hand no longer matches its id and is refused.
- (Amended 2026-10-25, #387: revisions can be pruned. `shaderera prune` removes the revisions
  nobody names and the objects only they held. It keeps the head, labelled revisions, those a job,
  a bake stamp or a comment names, those whose frozen copy is in use, and the last n saves, and
  removes the frozen copies nobody uses; a pruned revision's log lines stay, marked pruned.)
- Revisions never follow or store links and never write through one (an in-progress review on
  2026-10-08 showed a junction to an outside folder being saved and then restored over).

**What it is not.** A job holds execution inputs and references; it never describes the film. The
manifest stays the composition's manifest; the protocol (`render(t)`, capabilities) is unchanged.

**LOC impact.** About 450 owned lines (revisions, jobs, diff, CLI commands, server functions).

**Public API impact.** `Manifest.variants`, the `Variant` type, and `withVariant` in
`@shaderera/core/host`. Jobs and revisions are CLI files, not core API.

**How to reverse.** Remove `variants` from the manifest checker and the `project/` folder; exports
go back to rendering the working tree with defaults.
