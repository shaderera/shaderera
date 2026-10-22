# Contributing

Thank you for looking. Shaderera is young (0.1.x). Issues and pull requests are both welcome.

- **A bug:** open an [issue](https://github.com/shaderera/shaderera/issues) with what you ran, what
  you expected and what happened. `npx shaderera doctor --json` and the command's `--json` output
  help a lot.
- **An idea or a missing feature:** open an issue that says what you were trying to make and where
  Shaderera got in the way.
- **A security problem:** do not post the details in public. Open an issue titled "Security
  contact" with no details, and we will reach you privately.

To build and test from a clone, see [Develop](README.md#develop) in the README.

## Pull requests

A good pull request:
- does one thing, and is small enough to read in one sitting;
- passes `pnpm test:all` and `pnpm lint` (say in the description which slow tests could not run
  on your machine, such as the GPU or browser-host ones);
- updates the docs it changes, in the repository's plain style;
- is contributed under the same [MIT](LICENSE) licence as the code. Opening one says you agree.

For a large change, open an issue first, so we can agree on the shape before you write it.

## A new plugin

A plugin can go two ways:
1. **Into the official plugins**, by a pull request that adds `packages/plugins/<name>/` with its
   preview. The owner curates what gets in: it should come from a real film, carry no film's
   numbers, and be useful to another film as it is.
2. **Into your own library**, in your own repository, under your own licence and names. People use
   it with `npx shaderera add <name> --site <url>`. Nothing here needs to change.

[docs/plugin-guide.md](docs/plugin-guide.md) covers both: the label, naming, the rules the code
follows, versions, testing, the preview and hosting a library.

An official plugin carries its own preview for the website, in `preview/` beside its label:
`preview.json` (the caption, the states, the poster time) and an `index.ts` drawn in the house
style with `packages/plugins/previews/src/house.ts`. It is 1080², 6 s, a seamless loop, and every
asset in it is made in code. `preview/` is never in the label's `files`, so `add` and `publish`
leave it out.

Render it with `node packages/plugins/previews/scripts/render.ts <name>` (it needs ffmpeg with
libwebp) and look at `packages/plugins/<name>/preview/out/`. That folder is gitignored: the
previews are deterministic, so the code is what is kept, and the renders are never committed. A
maintainer uploads the renders.
