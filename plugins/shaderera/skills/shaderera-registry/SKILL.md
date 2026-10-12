---
name: shaderera-registry
description: Use when the person asks for the Shaderera registry by name or by what it does (search it, add or eject an item, publish a piece of a clip), names a registry item, when adding one of the plumbing items AUTHORING.md lists instead of writing the same plumbing again, or when a render or check fails because a required extension is missing. Do not use it to look for ready-made looks or motion while making a clip unless the person asked for that.
---

# Shaderera registry

A Shaderera film is code: `render(t)` in `src/`. The registry is a shelf of code that earlier
films proved, like npm for clips. It is there for the person to reach for. Write the film's code
yourself. The one exception is the **plumbing** that `AUTHORING.md` lists: items that carry no
taste, such as music analysis, three.js on the host's GPU or image decoding. Add one of those
instead of writing the same plumbing again, and say so in your summary. Add looks, motion and
sound design items only when the person asks. Never search or suggest items on your own. What
the film looks like comes from the brief and the person, and a generic part pulls a film toward
every other film.

Every command is `npx shaderera-registry <command>`. The registry is a folder: `--registry
<dir>`, else `SHADERERA_REGISTRY`, else `~/.shaderera/registry`. If `search` says there is no
registry or lists nothing, ask which folder the team uses before concluding nothing exists.

## 1. When the person asks you to search

Search in the words of their need, not of a guessed item name:

```
npx shaderera-registry search "beat sync"
npx shaderera-registry search "glitch captions" --type component
npx shaderera-registry search widenFov             # code too: exported names, WGSL functions, doc comments
npx shaderera-registry grep "safeArea\("           # a regex over every item's newest files
npx shaderera-registry info text-feature-captions  # label, licence, requires, files, and how to use it
```

Show them what you found and let them choose. Always read `info` before adding. It ends with the
item's README: the call to make, and what to watch for. Check the licence fits the use (the
engine's licence is separate from any item's), and what the item is built on.

## 2. When the person asks you to add an item

```
npx shaderera-registry add text-feature-captions  # copies src/type/captions.ts, and what it is built on
npx shaderera-registry add audio-beat-clock
npx shaderera-registry add font-ibm-plex-mono     # media: files under assets/
```

- **A component, preset or media item** is copied into the project at the paths it lists. Items
  it is built on (`requires.items`) come with it once. A later `add` never replaces a file the
  project already has; `--force` replaces only the item named.
- **An extension** is an npm package. `add` installs it and records it in `shaderera.item.json`
  under `requires`.

Then read the copied files: the comment at the top says what the module does and how. Wire it
into `render(t)`, pass the film's own times, fonts and sizes, and change anything the brief needs
changed. The defaults were chosen for another film. An item that is "almost it" should be edited,
not worked around.

## 3. When a command refuses the project

`shaderera render`, `check` and every other command refuse a project whose `shaderera.item.json`
requires a missing extension or the wrong version. The message names it. Never work around the
refusal silently. Pick one of the three ways out, by what the person wants:

1. **Install it:** `npx shaderera-registry add <name>@<range>`, when the requirement is what
   the film needs.
2. **Make it the project's own:** `npx shaderera-registry eject <name>`. It copies the installed
   code into `vendor/` and keeps the imports working. Use this when it must behave differently.
3. **Stop requiring it:** `npx shaderera-registry drop <name>`, then write the code yourself.
   Use this when the idea needs something the extension cannot be.

An extension must never stand between an expert and what they asked for. If nothing in the
registry does what they want, eject, edit, or write new code. Do not bend the brief to fit an
item. `npx shaderera-registry verify` lists what is missing without opening the film.

## 4. Record what the registry lacked

If the project keeps a `REGISTRY-GAPS.md` and a search the person asked for found nothing useful,
or an added item needed real changes, add a line to it: the date, what was searched for, what the
film needed, and what you did. Do not create the file or search just to fill it.

## 5. Craft that accepted films paid for

These held across films. They are not a style: the brief still sets the look.

- **Measure the music before cutting to it.** Analyse the exact file that plays, and take every
  time from that analysis. Listen to check the tempo: a measured BPM can be a ratio of the real
  one.
- **Name what the picture does while it does it.** A caption that arrives after the moment, or
  covers it, is worse than none. Keep the biggest moment of the music clear of all text.
- **Endings need room.** A song that stops dead needs a tail and real silence; hold
  the last picture into the silence.
- **A variant is relaid, never cropped.** Each format gets its own layout and safe area, and a
  tall frame opens the lens instead of losing the sides.
- **Look at frames, not numbers.** Stills of the moments that changed and a contact sheet, each
  variant included. Say what you did not judge by eye or ear.
- **You cannot hear or watch playback, so turn both into pictures.** Render the film, then draw
  the sound (spectrogram, waveform, onsets) and how much the picture changes every frame on one
  timeline, with strips of every frame around each moment that should hit, and measure picture
  against sound in ms. Judge sync, pacing and density from those before asking the person; then
  ask them to listen to the final, which no picture replaces.
- **Determinism:** `render(t)` is a function of t. No `Math.random`, no wall clock, hashes of the
  frame instead. GPU float blending in a scatter is order-dependent: use integer atomics.
  `npx shaderera still --diff <t>` and `npx shaderera check` catch a frame that depends on history.
- **WGSL traps:** `target` is a reserved word. Keep TypeScript and WGSL struct sizes in step and
  write the stride down. Guard `normalize` of a zero vector and `pow` of a negative base. Copy
  rows from a texture are padded to 256 bytes.

## 6. When the person asks you to publish a piece

Publish only what the person asks to share, and only from a clip they have accepted. Do not
propose pieces on your own. A piece too tied to its film to be made generic without a rewrite
stays in the film: the registry holds only what another film can use as it is. Make each
one generic first:

- no film-specific numbers: its times, copy and sizes become parameters;
- defaults that render well with nothing passed;
- it runs headless in Node and in the browser, deterministic;
- a short `README.md`: one line of what it does, then the call to make.

Lay it out as a folder holding `shaderera.item.json`, `README.md`, and the files at the paths a
project should get them, then `npx shaderera-registry publish <dir>`. For an extension, the label
is a `"shaderera"` field in its `package.json`.

```json
{
  "name": "text-code-wall",
  "type": "component",
  "title": "Code wall",
  "description": "The project's own source as a wall of text that scrolls and jumps on the beat",
  "category": "Typography",
  "tags": ["glitch", "code"],
  "version": "0.1.0",
  "licence": "MIT",
  "requires": { "items": { "text-kinetic": "^0.1.0" } },
  "files": ["src/type/code-wall.ts"]
}
```

The label is for finding the item and resolving what it needs. Nothing in it may change a frame:
what the film looks like is its code. Versions are immutable: to change an item, bump its
version.

- **Types:** `extension`, `component`, `preset`, `media` (decision 0011 retired templates).
- **Categories, for extensions, components and presets:** Audio & Music, Analysis & Tracking,
  Typography, Looks, Procedural & Particles, Transitions, Animation & Camera, Rendering,
  Layout & Formats.
- **Categories, for media:** Music, Sound Effects, Fonts, 3D Models, Images.
- **requires:** `shaderera` (a range), `extensions` (npm packages, installed and recorded),
  `items` (components, presets or media copied in with it) and `packages` (npm packages the
  copied code imports, such as `three`, installed unless the project has them).

Another category is allowed, and publishing warns so it can be reviewed. Media records its
`source`. For generated media such as AI music, it records the generator and its terms too.
