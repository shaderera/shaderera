# Plugins

Like npm for clips (decision 0008). A plugin is code that Shaderera films have proved, of four
types (decision 0011 retired templates: a project starts empty):
- package plugins (type `extension`: npm packages);
- components (small pieces of code);
- presets (data);
- media (music, fonts, models, images).

A person or their agent searches plugins, adds what fits, and owns the result as ordinary code.
To write one, see [plugin-guide.md](plugin-guide.md). Every command is part of `shaderera`:

```
npx shaderera search "glitch captions"         # full-text over names, descriptions and code
npx shaderera search widenFov --type component # also --category c, --tag x, --json
npx shaderera info text-feature-captions       # licence, what it copies and is built on, README
npx shaderera add text-feature-captions        # copies its files, and what it is built on
npx shaderera add @shaderera/music@^0.1        # a package plugin: installed, and required
npx shaderera remove @shaderera/music          # uninstalled, and no longer required
npx shaderera publish path/to/plugin --from <folder>
```

A component, preset or media plugin is copied into the project at the paths it lists, with what it
is built on, once. A later `add` never replaces a file the project already has; `--force` replaces
only the plugin named. Once copied, the files are the project's own code: to stop using one,
delete its files.

## Where plugins come from

Plugins come from a folder or the URL of one. Point to it in either of two ways:
- pass `--from <dir|url>`;
- set `SHADERERA_PLUGINS=<dir|url>`.

Without either, they are Shaderera's own at `https://shaderera.com/r`. A team shares a folder:
on a network drive, or in a git repository everyone checks out. A URL is such a folder served
over HTTP: each command downloads `index.json` and `search.json`, and the files of the versions it
reads, into `~/.shaderera/cache/` (or `SHADERERA_CACHE`), checks them against their sha256, and
works offline from the last copy. `publish` writes to a folder only. To fill a new folder with
the official plugins in
[packages/plugins/](https://github.com/shaderera/shaderera/tree/main/packages/plugins), from a
clone of that repository after `pnpm install`:

```
for d in packages/plugins/*/; do [ -f "$d/shaderera.item.json" ] && node apps/cli/bin/shaderera.js publish "$d" --from <folder>; done
```

The folder contains three things:
- `index.json`: every plugin and version, with its sha256;
- `search.json`: an inverted index built at publish, searched locally without a server;
- `items/<name>/<version>/`: the files. Package plugins also keep the `package.tgz` npm installs.

Versions are immutable: to change a plugin, bump its version. Every `add` checks the files
against the sha256 recorded at publish.

## The label

Components, presets and media carry `shaderera.item.json`. A package plugin carries the same
fields under `"shaderera"` in its package.json. `requires` names four things:
- a `shaderera` range;
- `extensions`: package plugins, installed and recorded in the project's label;
- `items`: components, presets or media copied in with it, once, never over a file the project
  already has;
- `packages`: npm packages the copied code imports, such as `three`, installed unless the project
  has them.

A `README.md` next to the label is published too: `info` prints it, and search reads its first
paragraph. The label is for finding a plugin and resolving what it requires. The host never reads
it to render, so nothing in it may change a frame.

## The one hard rule

When a project's `shaderera.item.json` requires a package plugin that is not installed, or the
wrong version, every `shaderera` command refuses the project and names the two ways out:
`npx shaderera add <name>@<range>` or `npx shaderera remove <name>`. `npx shaderera doctor` lists
it as `requires` without opening the film. A package plugin never stands in the way: remove it
and write your own.

## The skill

The `shaderera-plugins` skill lives in
[plugins/shaderera/](https://github.com/shaderera/shaderera/tree/main/plugins/shaderera), the
Claude Code plugin (a different thing from Shaderera's plugins). `create-shaderera` puts it in every new project at
`.claude/skills/shaderera-plugins/`. The project's agent searches, adds and publishes only when
the person asks, and recovers from a refusal. It never suggests plugins on its own.
