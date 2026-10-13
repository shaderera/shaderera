# Add-ons

Like npm for clips (decision 0008). An add-on is code that Shaderera films have proved, of four
types (decision 0011 retired templates: a project starts empty):
- package add-ons (type `extension`: npm packages);
- components (small pieces of code);
- presets (data);
- media (music, fonts, models, images).

A person or their agent searches a library, adds what fits, and owns the result as ordinary code.
Every command is part of `shaderera`:

```
npx shaderera search "glitch captions"         # full-text over names, descriptions and code
npx shaderera search widenFov --type component # also --category c, --tag x, --json
npx shaderera info text-feature-captions       # licence, what it copies and is built on, README
npx shaderera add text-feature-captions        # copies its files, and what it is built on
npx shaderera add @shaderera/music@^0.1        # a package add-on: installed, and required
npx shaderera remove @shaderera/music          # uninstalled, and no longer required
npx shaderera publish path/to/add-on --library <folder>
```

A component, preset or media add-on is copied into the project at the paths it lists, with what it
is built on, once. A later `add` never replaces a file the project already has; `--force` replaces
only the add-on named. Once copied, the files are the project's own code: to stop using one,
delete its files.

## Libraries

Add-ons come from a library: a folder or the URL of one. Point to it in either of two ways:
- pass `--library <dir|url>`;
- set `SHADERERA_LIBRARY=<dir|url>`.

Without either, it is the official catalog at `https://shaderera.com/r`. A team shares a folder:
on a network drive, or in a git repository everyone checks out. A URL is a library folder served
over HTTP: each command downloads `index.json` and `search.json`, and the files of the versions it
reads, into `~/.shaderera/cache/` (or `SHADERERA_CACHE`), checks them against their sha256, and
works offline from the last copy. `publish` writes to a folder only. To fill a new library with
the official add-ons in
[packages/catalog/](https://github.com/shaderera/shaderera/tree/main/packages/catalog), from a
clone of that repository after `pnpm install`:

```
for d in packages/catalog/*/; do [ -f "$d/shaderera.item.json" ] && node apps/cli/bin/shaderera.js publish "$d" --library <folder>; done
```

The folder contains three things:
- `index.json`: every add-on and version, with its sha256;
- `search.json`: an inverted index built at publish, searched locally without a server;
- `items/<name>/<version>/`: the files. Package add-ons also keep the `package.tgz` npm installs.

Versions are immutable: to change an add-on, bump its version. Every `add` checks the files
against the sha256 recorded at publish.

## The label

Components, presets and media carry `shaderera.item.json`. A package add-on carries the same
fields under `"shaderera"` in its package.json. `requires` names four things:
- a `shaderera` range;
- `extensions`: package add-ons, installed and recorded in the project's label;
- `items`: components, presets or media copied in with it, once, never over a file the project
  already has;
- `packages`: npm packages the copied code imports, such as `three`, installed unless the project
  has them.

A `README.md` next to the label is published too: `info` prints it, and search reads its first
paragraph. The label is for finding an add-on and resolving what it requires. The host never reads
it to render, so nothing in it may change a frame.

## The one hard rule

When a project's `shaderera.item.json` requires a package add-on that is not installed, or the
wrong version, every `shaderera` command refuses the project and names the two ways out:
`npx shaderera add <name>@<range>` or `npx shaderera remove <name>`. `npx shaderera doctor` lists
it as `requires` without opening the film. A package add-on never stands in the way: remove it
and write your own.

## The skill

The `shaderera-addons` skill lives in
[plugins/shaderera/](https://github.com/shaderera/shaderera/tree/main/plugins/shaderera), with the
Claude Code plugin. `create-shaderera` puts it in every new project at
`.claude/skills/shaderera-addons/`. The project's agent searches, adds and publishes only when
the person asks, and recovers from a refusal. It never suggests add-ons on its own.
