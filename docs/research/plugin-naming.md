# Plugin naming and install

Research of 2026-10-13, before [0014](../adr/0014-plugins-in-one-cli.md). It asked whether to
rename the registry, its items and its install command while the names lived in one repository.
0014 took the one-CLI finding and the security fix. Against the evidence below, the owner chose
"plugin" as the one word users see; docs say "the Claude Code plugin" for that one.

## Findings that became decisions

- **`npx shaderera-registry` could run a stranger's code.** Outside a project, `npx` resolves the
  first argument as a package name, and with no TTY or in CI it assumes `--yes`
  ([npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec)). The unscoped name
  `shaderera-registry` was unowned, so anyone could publish it. Fixed by folding the commands into
  `shaderera` and reserving the old name.
- **One CLI is cheap and short.** `shaderera add x` is the depth of `npx shadcn add x`
  ([shadcn CLI](https://ui.shadcn.com/docs/cli)) and `npx remotion add x`
  ([Remotion CLI](https://www.remotion.dev/docs/cli/add)). Claude Code needs `claude plugin …`
  only because `claude` takes a prompt as its first argument.
- **`name@source` cannot work:** `name@range` already parses as a version range. A bare name
  keeps meaning the official source, as a bare formula means Homebrew core
  ([Taps](https://docs.brew.sh/Taps)).
- **Published names are permanent.** Claude Code: renaming a plugin "breaks every existing
  install", and marketplaces keep an append-only `renames` map
  ([Host a marketplace](https://code.claude.com/docs/en/plugins/host-marketplace)). VS Code keeps
  removed names reserved forever
  ([Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)).

## The word "plugin"

- In every tool surveyed that uses it, **"plugin" and "extension" mean code the host loads at
  run time**: VS Code, Obsidian, Raycast, Blender, Unreal, Figma, Motion Canvas, Hydra, Claude
  Code, Gemini CLI.
- **Copied-in things get other nouns:** component, block, element, template, preset, snippet,
  file, sample, addon (openFrameworks, Godot).
- **Claude Code's own nouns sit in the same session.** A plugin bundles "skills, agents, hooks,
  and MCP servers"; "A marketplace is a catalog of plugins"
  ([Install and manage plugins](https://code.claude.com/docs/en/discover-plugins)). Shaderera's
  Claude Code plugin installs with `claude plugin install shaderera@shaderera`.
- **npm keyword counts (2026-10-13):** plugin 55,663 · component 49,771 · template 19,442 ·
  extension 8,235 · effect 2,240 · addon 1,582 · preset 1,568 · kit 999 · pack 863.
- **Motion marketplaces** (VideoHive, Envato, Motion Array) use three words for three things:
  template = a finished project you copy, preset = settings you apply, plugin = host code.
- **"Pack" means a bundle**, not one unit: Ableton Packs ([Packs](https://www.ableton.com/en/packs/)),
  vvvv packs ([Gray Book](https://thegraybook.vvvv.org/reference/libraries/overview.html)).
- **"Preset" never means code** anywhere surveyed, which matches the data-only `preset` type.
- Agents follow a skill's own words; Anthropic's guidance is to pick one term and keep it
  ([Skill best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)).

Still open: `shaderera search` could treat "template", "effect", "preset" and "pack" as words that
find plugins, keeping the docs' nouns exact.

## Survey

| Tool | Add-on noun(s) | Install route | Lands in | Naming | Copy or runtime |
|---|---|---|---|---|---|
| [shadcn/ui](https://ui.shadcn.com/docs/registry/namespace) | registry item (`type`: ui, block, font…) | `npx shadcn add` | project source | `@namespace/item`; `owner/repo/item` | **copy** |
| [Remotion](https://www.remotion.dev/elements) | package; Element; Element Library | `npx remotion add`; Studio "Browse Elements" | `node_modules`; `.element.tsx` | `@remotion/*`; `<category>/<slug>` | runtime; **copy** |
| [Motion Canvas](https://motioncanvas.io/docs/plugins) | plugin | npm + `plugins: []` | `node_modules` | npm | runtime |
| [Hydra](https://hydra.ojack.xyz/docs/docs/learning/extending-hydra/extensions/) | extension | `loadScript(url)` | fetched at run | URL | runtime |
| [drei](https://github.com/pmndrs/drei) | helpers | `npm install` | `node_modules` | npm scope | runtime |
| [p5.js](https://p5js.org/contribute/creating_libraries/) / [Processing](https://github.com/processing/processing-contributions) | library / contribution | script tag; Contribution Manager | page / sketchbook | `p5.` reserved for core | runtime |
| [openFrameworks](https://ofxaddons.com/howto) / [Cinder](https://libcinder.org/docs/guides/cinder-blocks/index.html) | addon / CinderBlock | copy folder | `addons/`, `blocks/` | `ofx*`; reverse-DNS | **copy** |
| [cables.gl](https://cables.gl/docs/5_writing_ops/guidelines/guidelines) | op | add in editor | patch | `Ops.User.name`, `Ops.Team.*` | both |
| After Effects | plug-in, script, preset (.ffx), .mogrt, CEP → [UXP plugin](https://developer.adobe.com/uxp/guides/explanation/fundamentals/nomenclature/) | per-kind folders and panels | per kind; preset → keyframes | none | plug-in runtime; preset/template **copy** |
| [Cavalry](https://docs.cavalry.scenegroup.co/tech-info/third-party-plugins/) | script; third-party plugin | Scripts folder; drag .zip | app-support dirs | none | runtime |
| [Rive](https://rive.app/docs/community/marketplace-overview) | file (Marketplace, CC BY) | Remix | your files | — | **copy** |
| [TouchDesigner](https://docs.derivative.ca/Palette) | component (.tox), OP Snippet | drag from Palette | network | — | **copy** |
| [Nuke](https://learn.foundry.com/nuke/content/comp_environment/configuring_nuke/creating_sourcing_gizmos.html) | gizmo; Group | `NUKE_PATH`, `menu.py` | plugin path; script | — | runtime; `makeGroup` → **copy** |
| Fusion / Resolve | macro, template, Fuse; Reactor atom package | folders; Reactor | user dirs | reverse-DNS | runtime |
| [Max](https://docs.cycling74.com/userguide/abstractions/) / Ableton | package; abstraction; .amxd; Pack | Package Manager; User Library | Packages | — | runtime; embed → **copy** |
| [Blender](https://docs.blender.org/manual/en/latest/editors/preferences/extensions.html) | extension (add-on, theme) | Get Extensions; drag URL; `--command extension install` | repository (remote/user/system) | `bl_ext.<repo>.<id>` | runtime; assets Link or Append |
| [Unity](https://docs.unity3d.com/Manual/upm-concepts.html) | package, [sample](https://docs.unity3d.com/Manual/cus-samples.html) | Install; sample Import; Customize | immutable cache; `Assets/` | `com.company.name`; scoped registries | runtime; samples **copy** |
| [Unreal / Fab](https://dev.epicgames.com/documentation/en-us/unreal-engine/plugins-in-unreal-engine) | plugin; asset, pack | Install to Engine; Add to Project | `Plugins/`; content | `.uplugin` | runtime; assets **copy** |
| [Godot](https://docs.godotengine.org/en/stable/community/asset_library/using_assetlib.html) | asset, addon | AssetLib Install | `addons/` | — | **copy** |
| [Houdini](https://www.sidefx.com/docs/houdini/assets/namespaces.html) | digital asset | import; `HOUDINIPATH/otls` | library file | `namespace::name::version` | runtime |
| [Figma](https://help.figma.com/hc/en-us/articles/360042532714-Use-plugins-in-files) | plugin, widget; file, library | Run; duplicate; enable | account; linked | — | runtime; files **copy** |
| [VS Code](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace) | extension | `code --install-extension` | `~/.vscode/extensions` | `publisher.extension` | runtime |
| [Obsidian](https://obsidian.md/help/Extending+Obsidian/Community+plugins) | community plugin | Browse → Install → Enable | vault config | no "obsidian", no "plugin" suffix | runtime |
| [Raycast](https://manual.raycast.com/extensions) | extension | Store | app | — | runtime |
| [Homebrew](https://docs.brew.sh/Formula-Cookbook) | formula, cask (in taps) | `brew install`, `brew tap` | Cellar | `user/repo/formula`; bare = core | runtime |
| [Claude Code](https://code.claude.com/docs/en/plugins/cli-reference) | plugin (in a marketplace) | `claude plugin install name@mkt` | Claude settings | `name@marketplace` | runtime |
| [Gemini CLI](https://geminicli.com/docs/extensions/) | extension | `gemini extensions install <url>` | user config | URL | runtime |

What the table shows:
- **Copy-in tools say "add"** (shadcn, Remotion packages; Godot and Unity import into the project).
- **Federated sources are named by owner, never by category**: `@namespace`, `owner/repo`,
  `publisher.extension`, `Ops.User.name`, `bl_ext.<repo>`, `com.company`. A category prefix such
  as `<category>-<thing>` sorts plugins inside one source and proves no ownership across sources,
  the reason npm and JSR have scopes ([npm scopes](https://docs.npmjs.com/about-scopes);
  [RFC 3243](https://rust-lang.github.io/rfcs/3243-packages-as-optional-namespaces.html)).
- **Every reference-vs-copy tool has an explicit eject**: Nuke gizmo → Group, Max "Abstraction to
  Embedded Subpatcher", Unity Customize, Blender Append, Roblox packages that stop updating once
  edited.
- **One umbrella noun with typed kinds** is the usual registry shape (shadcn item + `type`,
  Claude Code plugin, Blender extension, Godot asset). Host apps that grew kinds one at a time
  (After Effects, Nuke, Fusion) have a noun and a folder per kind, and umbrella words drift upward
  over older per-kind words.
- **Blender is the closest model** to a folder-or-URL source: `repo-add ID [--url]`,
  `server-generate --repo-dir` builds a static index, a third party hosts "a single hosted JSON
  file", and it "won't connect to the Internet by default"
  ([CLI](https://docs.blender.org/manual/en/dev/advanced/command_line/extension_arguments.html);
  [beta post](https://code.blender.org/2024/05/extensions-platform-beta-release/)).
- **Remotion Elements is the closest competitor shape:** copied in, category-named, federated by
  URL (`Config.addElementLibrary`), agent-aware
  ([Browse elements](https://remotion.dev/docs/studio/browse-elements)).

## Renames after adoption

| Rename | Reason | Cost |
|---|---|---|
| Blender add-ons → extensions (4.2, 2024) | updates, in-app discovery, a trustworthy ecosystem ([2022 post](https://code.blender.org/2022/10/blender-extensions-platform/)) | bundled add-ons moved out; `bl_ext.*` forced relative imports; the UI got a separate "Add-ons" page back ([DevTalk](https://devtalk.blender.org/t/extensions-platform/34663)). The old word never left. |
| Unreal Marketplace + Sketchfab + Quixel + ArtStation → Fab (2024) | one store across engines ([announcement](https://forums.unrealengine.com/t/announcing-fab-an-evolution-of-the-unreal-engine-marketplace/795198)) | launch slipped a year; libraries migrated; ArtStation became a "legacy library" |
| Adobe ExtendScript → Flash → CEP → UXP plugins | maintenance, performance, security ([2026-09 post](https://blog.developer.adobe.com/en/publish/2026/09/investing-in-the-future-of-creative-cloud-extensibility-uxp-comes-to-our-flagship-applications)) | a rewrite per plugin ([migration](https://developer.adobe.com/uxp/migration-center/)); CEP retires end of 2029. Four nouns in about fifteen years. |
| Godot Asset Library → Asset Store (2026) | "hard to evolve while maintaining compatibility" ([post](https://godotengine.org/article/introducing-the-godot-asset-store/)) | nothing migrates automatically; the old library goes read-only |
| three.js examples → addons (r144–r147) | "examples" misled users | moving the folder "would break a lot of paths and URLs", so `addons` is only an alias ([#24595](https://github.com/mrdoob/three.js/issues/24595)) |
| shadcn `shadcn-ui` → `shadcn` (2024) | none stated | old package left on npm, deprecated |
| SideFX GameDev Toolset → Labs | "useful for more than game development" | little; format unchanged |

Every rename left an alias or legacy path that never closed, and the ones that changed the format
or host were expensive. Renaming before anyone outside depends on a name is the cheap case.

## Named sources, when they come

0014 defers named sources (`shaderera source add <url>`, `@owner/name`) until a second source of
plugins exists. What the survey says for that day:
- **Adding a source is opt-in** before any of its plugins resolve, as in shadcn and Claude Code.
  Write it in `shaderera.json` so a team shares it (shadcn writes `components.json`).
- **`@source/name` collides with npm scopes.** The name rule already allows a scope, and a
  package plugin takes its npm name, so `@acme/glow` could mean either. Keep plugin names
  unscoped and carry a package plugin's npm name in its own field.
- **`owner/repo/name`** (Homebrew, shadcn GitHub, skills.sh) cannot be read as a scope but ties
  the name to the repo's location: moving the repo breaks every `requires` entry.
- **Reserve names and prove owners:** reserve `shaderera` and `official` as source names, forbid
  `shaderera` in third-party plugin names (Obsidian forbids "obsidian"
  ([Manifest](https://docs.obsidian.md/Reference/Manifest)); Unity reserves `com.unity`), and keep
  a `renamed` map instead of renaming in place.
- **An official set in its own repo** has precedent (homebrew/core, `raycast/extensions`), but
  three.js keeps addons in core so they move with each release. A split repo needs CI against
  every `shaderera` release.
