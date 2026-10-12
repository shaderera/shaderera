# @shaderera/registry

Like npm for clips (decision 0008). A registry holds what Shaderera films have proved, as four
kinds of item (decision 0011 retired templates: a project starts empty):
- extensions (npm packages);
- components (small pieces of code);
- presets (data);
- media (music, fonts, models, images).

A person or their agent searches it, adds what fits, and owns the result as ordinary code.

```
npx shaderera-registry search "glitch captions"     # full-text over labels and code
npx shaderera-registry info @shaderera/music
npx shaderera-registry add @shaderera/music@^0.1    # installs, and records it in shaderera.item.json
npx shaderera-registry eject @shaderera/music       # its code into vendor/, now the project's own
npx shaderera-registry drop @shaderera/music        # stop requiring it; write your own
npx shaderera-registry verify
npx shaderera-registry publish path/to/item
```

## In-house

A registry is a folder, so the team shares one. It can sit on a network drive or in a git
repository everyone checks out. Point to it in either of two ways:
- set `SHADERERA_REGISTRY=<folder>`;
- pass `--registry <folder>`.

Without either, it is `~/.shaderera/registry`. To fill a new registry with the official items
in [packages/catalog/](../../packages/catalog/):

```
for d in packages/catalog/*/; do [ -f "$d/shaderera.item.json" ] && npx shaderera-registry publish "$d" --registry <folder>; done
```

The folder contains three things:
- `index.json`: every item and version, with its sha256;
- `search.json`: an inverted index built at publish, searched locally without a server;
- `items/<name>/<version>/`: the files. Extensions also keep the `package.tgz` npm installs.

Versions are immutable. Every `add` checks the files against the sha256 recorded at publish.

## The label

Templates, components, presets and media carry `shaderera.item.json`. An extension carries the
same fields under `"shaderera"` in its package.json. `requires` names four things:
- a `shaderera` range;
- `extensions`, installed and recorded in the project's label;
- `items`: components, presets or media copied in with it, once, never over a file the project
  already has;
- `packages`: npm packages the copied code imports, such as `three`, installed unless the project
  has them.

A `README.md` next to the label is published too: `info` prints it, and search reads its first
paragraph. The label is for finding an item and resolving what it requires. The host never reads
it to render, so nothing in it may change a frame.

## The one hard rule

When a project's `shaderera.item.json` requires something that is not installed, or the wrong
version, every `shaderera` command refuses the project and names the three ways out: `add`,
`eject` or `drop`. An extension never stands in the way. Eject it, or drop it and write your own.

## The skill

The `shaderera-registry` skill lives in [plugins/shaderera/](../../plugins/shaderera/), with the
Claude Code plugin. `create-shaderera` puts it in every new project at
`.claude/skills/shaderera-registry/`. The project's agent searches, adds and publishes only when the
person asks, and recovers from a refusal. It never suggests items on its own.
