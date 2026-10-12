# 0008: Core, extensions and the catalog

2026-10-10. Owner accepted, without the launch-film listing as a first step. It is
loose on purpose: nothing has launched yet, so it fixes only what protects users and leaves the
rest to be learned. The background was researched in internal reports, 2026-10-10.

**Amended by [0011](0011-experts-and-agents-no-taste-lock.md) (2026-10-12).**
- The `template` type and its categories are retired, so there are four types.
- Agents may add plumbing items without being asked; looks and motion items only on request.

**Context.** The Shaderera opening film (an in-house project) needed pieces the engine does not
have. It built them itself:
- music analysis and conforming a song's ending;
- platform safe areas and a lens rule for tall frames;
- screen looks;
- kinetic captions;
- text as points;
- blob tracking;
- a 2M-particle engine.

The owner wants each new clip to leave such pieces behind for everyone, in a catalog users browse
and pick from. The owner's answers (2026-10-10):
- The engine licence charges companies, Remotion-style.
- Official catalog items are MIT.
- The opening film may become an official template later; it is not one of the first steps.
- The catalog is mostly free.
- There is no date for opening it to outside authors.

**What does not change.**
- **No IR, no scene schema; code is the source of truth.** A template is code copied into the
  project. An extension is code the project imports. A user may change or replace any of it.
- **Core does the boring production work:** timing, determinism, export, variants and safe
  areas, review, delivery, revisions and jobs. Creative work belongs to the project's code.
- **Catalog metadata is for finding things and resolving dependencies only.** Type, category,
  tags, requirements and licence never describe the film, and the host never reads them when it
  renders. One test decides what may go there: if changing a field could change a rendered frame,
  it does not belong in the metadata.

**Decision.**

1. **Three layers.**
   - **Core:** `@shaderera/core` and `shaderera`, released with the same version number, plus
     `create-shaderera`.
   - **Extensions:** npm packages that list `@shaderera/core` as a peer dependency.
   - **Catalog items:** templates, components, presets and media, copied into the project.
2. **Five item types**, one per item:
   - `template`: a whole clip, as source;
   - `extension`: an installable package;
   - `component`: a small piece of copied-in code;
   - `preset`: data only, with no runnable code;
   - `media`: music, sound effects, fonts, models or images.
3. **Categories by type.** Templates are grouped by what they deliver; everything else by which
   part of the work it covers. The starting lists are below. A category shows as soon as it has
   one item, and anyone may propose a new one.
   - **Templates:** Launch & Opener, Product Film, Logo & Identity Reveal, Social Promo, Kinetic
     Typography.
   - **Extensions, components and presets:** Audio & Music, Analysis & Tracking, Typography,
     Looks, Procedural & Particles, Transitions, Layout & Formats.
   - **Media:** Music, Sound Effects, Fonts, 3D Models, Images.
4. **Tags are free for now.** Use case and style go in tags ("corporate", "glitch"). There are
   no limits and no controlled list until there are enough items to need them.
5. **Requirements are declared, and a missing one fails loudly.**
   - An item lists, in its label (`shaderera.item.json`, or `"shaderera"` in an extension's
     `package.json`), the core range and the extensions it needs. It may also require other items
     (`requires.items`, copied in with it) and the npm packages its copied code imports
     (`requires.packages`).
   - If one is missing or the wrong version, the project refuses to open and says which one.
     It never falls back silently.
   - This is the only hard rule, because silent fallbacks are how After Effects templates and
     TouchDesigner components break.
6. **Two licences, said plainly.**
   - The engine's licence (companies pay) is separate from each item's licence (official items
     are MIT).
   - An item's page says so in one line.
   - Media records where it came from and its licence. For AI-generated music, it records the
     generator and that generator's terms.
7. **Extraction from a film.** A piece taken out of an accepted film may be listed right away.
   Where it can be checked, the film should still render the same frames through the extracted
   piece; this is recommended, not required.

**What this amends.**
- The earlier roadmap's "no large marketplace/catalog" (that roadmap has since been removed): a
  catalog is allowed. Its size is never a goal.
- An earlier freeze on feature expansion: extracting pieces from an accepted film into
  extensions is not expansion.
- "Keep the three-package distribution": core stays as it is, and each extension is its own
  package.
- "An adapter becomes a package only when a second project uses it": one accepted film is enough
  to list it, marked experimental.
- `packages/core/src/index.ts` calls the API "semver-covered". Versions follow 0.x semver, where
  any minor may break, loudly.

**Left open on purpose.**
- Who curates tags and categories.
- Review times.
- Quality gates in CI.
- A lockfile with hashes.
- "Featured" status.
- Paid items.
- When outside authors may publish.

Each is decided when the catalog has enough items or users to need it.

**Where the items live.** The official items are in `packages/catalog/` in this repository, one folder
each, MIT code and OFL fonts. `apps/registry` (`@shaderera/registry`, the `shaderera-registry`
CLI) publishes them to a registry folder, and searches, adds, ejects and drops them in a project.

**First steps.**
1. Write the item manifest (type, category, tags, requires, licence) and have `check` refuse a
   missing requirement.
2. Make one safe-area source that projects can read at render time.
3. Extract `glyph-points`, `layout`, `music` and `looks` from the opening film.
