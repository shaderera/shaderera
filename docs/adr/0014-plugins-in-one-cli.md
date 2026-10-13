# 0014: Plugins in one CLI

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
   - `eject` and `drop` became `remove`, which uninstalls a package plugin and stops requiring
     it.
   - `verify` became a `requires` line in `doctor`.
2. **One word: plugin.**
   - A first draft used three nouns for one thing: "add-on" for a piece, "library" for where
     pieces come from, and "catalog" for the official set. The owner dropped "library" and
     "catalog" as nouns, then chose "plugin" over "add-on" as the one word users see.
   - The owner chose it knowing the research above: it also names Claude Code plugins. Docs
     always write "the Claude Code plugin" for that one (`plugins/shaderera/`,
     `claude plugin install shaderera@shaderera`), so the two are never confused.
   - Where plugins come from is said without a noun: a folder or the URL of one,
     `--from <dir|url>`, else `SHADERERA_PLUGINS`, else Shaderera's own at
     `https://shaderera.com/r`.
   - "Item" stays as the code's term (`apps/cli/src/registry/`, `shaderera.item.json`,
     `shaderera.registry/1`).
   - The official plugins are in `packages/plugins/`; the site's page is `/plugins`; the skill is
     `shaderera-plugins`.
3. **A copied plugin is the project's code.** There is no command to delete one: deleting files a
   person may have edited is theirs to do.
4. **Plugins over HTTP are mirrored, not trusted.**
   - Each command fetches the index and the files it reads into `~/.shaderera/cache/`.
   - Files are checked against their sha256, a path that leaves its folder is refused, and the
     last copy is used offline.
   - Shaderera's own are built from `packages/plugins/` into shaderera-web's static assets.
5. **Every plugin gets a preview.** It is a 6 s square loop with its name and one sentence saying
   what it does, plus frames to scrub t. Each plugin carries its preview in its own `preview/`
   folder, `packages/plugins/previews/` renders them into that folder's `out/`, and the renders
   go to R2. Interactive states are for plugins whose range needs them.
   - The renders are never committed. `render(t)` is deterministic, so the code is the preview
     and the media is a build product, like `dist/`. One render of every plugin is about 400 MB;
     kept in git, every re-render would stay in the public history for good.
   - A contributor matches the house format through the `preview/` folder, `house.ts` and the
     one render command, not by committing files.

**Not now, and what starts each.**
- **Named sources (`shaderera source add <url>`) and `@owner/name` names:** when a second
  source of plugins exists.
  - Until then, `--from <url>` reaches one.
  - A bare name will keep meaning Shaderera's own, as a bare formula means Homebrew core.
  - `name@source` is ruled out because `@` already starts a version range.
- **The official plugins in their own repo:** when outside contributors need it. Pull requests
  to `packages/plugins/` work today, and in one repo an engine change is one change.
- **Renaming the type `extension`:** when the first package plugin exists. `requires.packages`
  already means plain npm dependencies, so `package` would collide.

**Consequences.**
- Published names are permanent. Renaming one breaks every project and link that uses it, so
  choose names before publishing.
- The npm name `shaderera-registry` should be reserved, so the old command cannot run someone
  else's code.
- `@shaderera/registry` 0.1.1 stays on npm, deprecated.
