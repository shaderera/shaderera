# 0014: Add-ons, libraries and one CLI

2026-10-13. Decided by the owner, before anyone outside the team used the registry.

**Context.** [0008](0008-core-extensions-and-catalog.md) shipped the catalog as "registry items"
behind a second CLI, `npx shaderera-registry`, in its own package `@shaderera/registry`. The
first feedback was that it was hard to use:
- a person could only get the items by cloning the monorepo and running a publish loop;
- the names (`review-av-timeline`, `look-screen-passes`) mean nothing without a picture.

The research in `research_notes/add-on naming and install.md` added three findings:
- **A security hole.** Outside a project, `npx shaderera-registry` resolves the unscoped npm name
  `shaderera-registry`, which nobody owned, and without a terminal npx answers yes by itself.
- **"Registry" is a word users do not know** outside npm, Docker and Unity.
- **"Plugin" means code loaded at run time.** That is true in every tool surveyed, and it is
  also the word for Claude Code's own plugins, which sit in the same agent session.

**Decisions.**

1. **One CLI.** `shaderera add`, `search`, `info`, `remove` and `publish`.
   - The code moved into `apps/cli/src/registry/`.
   - `@shaderera/registry`, its bin, and its devDependency in every new project are gone.
   - `grep` is gone, since `search` covers code.
   - `eject` and `drop` became `remove`, which uninstalls a package add-on and stops requiring
     it.
   - `verify` became a `requires` line in `doctor`.
2. **The words.**
   - **Add-on:** one piece; "item" stays as the code's term.
   - **Library:** where add-ons come from. It is a folder or the URL of one: `--library`, or
     `SHADERERA_LIBRARY`.
   - **Catalog:** the official library, and the default, at `https://shaderera.com/r`.
   - The skill is `shaderera-addons`.
3. **A copied add-on is the project's code.** There is no command to delete one: deleting files a
   person may have edited is theirs to do.
4. **A library over HTTP is mirrored, not trusted.**
   - Each command fetches the index and the files it reads into `~/.shaderera/cache/`.
   - Files are checked against their sha256, a path that leaves its folder is refused, and the
     last copy is used offline.
   - The catalog is built from `packages/catalog/` into shaderera-web's static assets.
5. **Every add-on gets a preview.** It is a 6 s square loop with its name and one sentence saying
   what it does, plus frames to scrub t. The sources are in `packages/catalog/previews/`, and the
   renders go to R2. Interactive states are for add-ons whose range needs them.

**Not now, and what starts each.**
- **`shaderera library add <url>` and `@owner/name` names:** when a second library exists.
  - Until then, `--library <url>` reaches one.
  - A bare name will keep meaning the catalog, as a bare formula means Homebrew core.
  - `name@source` is ruled out because `@` already starts a version range.
- **The catalog in its own repo:** when outside contributors need it. Pull requests to
  `packages/catalog/` work today, and in one repo an engine change is one change.
- **Renaming the type `extension`:** when the first package add-on exists. `requires.packages`
  already means plain npm dependencies, so `package` would collide.

**Consequences.**
- Published names are permanent. Renaming one breaks every project and link that uses it, so
  choose names before publishing.
- The npm name `shaderera-registry` should be reserved, so the old command cannot run someone
  else's code.
- `@shaderera/registry` 0.1.1 stays on npm, deprecated.
