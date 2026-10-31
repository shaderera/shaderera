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
npx shaderera search "glitch titles"           # full-text over names, descriptions and code
npx shaderera search widenFov --type component # also --category c, --tag x, --json
npx shaderera info text-glitch-titles          # licence, what it copies and is built on, README
npx shaderera add text-glitch-titles           # copies its files, and what it is built on
npx shaderera add camera-keyframes look-vignette  # several at once: all of them, or none
npx shaderera add @shaderera/music@^0.1        # a package plugin: installed, and required
npx shaderera remove @shaderera/music          # uninstalled, and no longer required
npx shaderera publish path/to/plugin path/to/other --site <folder>
```

A component, preset or media plugin is copied into the project at the paths it lists, with what it
is built on, once. A later `add` never replaces a file the project already has; `--force` replaces
only the plugin named. Once copied, the files are the project's own code: to stop using one,
delete its files. A media plugin also gets a record in the project's `ASSETS.md` (made when
missing): its version, licence, source and files, between `<!-- plugin <name> -->` markers that a
later `add` of it replaces. Delete the record with the files. A package plugin's tarball is copied
into the project's `vendor/` (`vendor/shaderera-music-0.1.0.tgz`) and installed from there, so
`package.json` names the project's own copy and a clone installs without the plugin cache.

`add` and `remove` take several names. `add` resolves every one, and what each is built on,
before it copies anything: if one is missing, nothing is copied. A range named on the command
line wins over the one a plugin requires, but a version outside a range another plugin requires
is refused, naming both: name a version in that range, or add them one at a time. `remove`
checks that each is a package plugin the project uses (required in its `shaderera.json`, or
installed with a `shaderera` field) before it uninstalls any; it never uninstalls a plain npm
dependency. `publish` takes several folders (a bare name such as `my-plugin` is a folder here,
never an npm package) and publishes each in turn. A folder that fails does not stop the rest: the end names each one that
failed, and the command exits with an error.

## Where plugins come from

Plugins come from the site, a folder, or the URL of one:
- `--site <origin>` reads the site's `<origin>/r`, and so does `SHADERERA_SITE=<origin>`, the
  same site `share` and `studio` use;
- `--site <url>` with a path reads the folder served there (`https://you.github.io/lib/r`);
- `--site <dir>` reads a folder.

Without either, they are Shaderera's own at `https://shaderera.com/r`. A team shares a folder:
on a network drive, or in a git repository everyone checks out. A URL is such a folder served
over HTTP: each command downloads `index.json` and `search.json`, and the files of the versions it
reads, into `~/.shaderera/cache/` (or `SHADERERA_CACHE`), checks them against their sha256, and
works offline from the last copy. `--site <dir>` wants a folder of published plugins, with an
`index.json`. A folder of plugin sources, such as `packages/plugins/`, is refused with this hint:
publish them into a folder first. `publish` writes to a folder only. To fill a new folder with
the official plugins in
[packages/plugins/](https://github.com/shaderera/shaderera/tree/main/packages/plugins), from a
clone of that repository after `pnpm install`:

```
for d in packages/plugins/*/; do [ -f "$d/shaderera.item.json" ] && node apps/cli/bin/shaderera.js publish "$d" --site <folder>; done
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
- `extensions`: package plugins, installed and recorded in the project's `shaderera.json`;
- `items`: components, presets or media copied in with it, once, never over a file the project
  already has;
- `packages`: npm packages the copied code imports, such as `three`, installed unless the project
  has them.

A `README.md` next to the label is published too: `info` prints it, and search reads its first
paragraph. The label is for finding a plugin and resolving what it requires. The host never reads
it to render, so nothing in it may change a frame.

## The one hard rule

A project's own `requires` lives in its `shaderera.json` ([protocol.md](protocol.md#shadererajson)):
a `shaderera` range and `extensions`, which `add` and `remove` keep. Before 0.1.5 it was in the
project's `shaderera.item.json`; one still there is refused with a message to move it.

When a project requires a package plugin that is not installed, or the
wrong version, every `shaderera` command refuses the project and names the two ways out:
`npx shaderera add <name>@<range>` or `npx shaderera remove <name>`. `npx shaderera doctor` lists
it as `requires` without opening the film. A package plugin never stands in the way: remove it
and write your own.

## The skill

The `shaderera-plugins` skill lives in
[plugins/shaderera/](https://github.com/shaderera/shaderera/tree/main/plugins/shaderera), the
Claude Code plugin (a different thing from Shaderera's plugins), which installs it in Claude
Code; other agents get it with `npx skills add shaderera/shaderera`. The project's agent searches, adds and publishes only when
the person asks, and recovers from a refusal. It never suggests plugins on its own.
