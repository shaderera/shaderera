# Licences

What the published packages (0.1.4) depend on, and what the official plugins and the test fixtures vendor.
Every package (`@shaderera/core`, `shaderera`, `create-shaderera`), the official plugins and the
agent skills are MIT. Each tarball carries its own licence file.

The runtime lists come from the packed tarballs installed with npm in a fresh `create-shaderera`
project (Windows x64). They walk `dependencies` and installed `optionalDependencies` from each
package's own `package.json`; on Linux the native bindings are the `linux-x64-gnu` variants of the
same packages under the same licences. Versions move; re-run the walk before a release.

**No GPL, AGPL, LGPL or unknown licence ships.**

## `@shaderera/core`

@webgpu/types 0.1.74, BSD-3-Clause (types only).

## `shaderera` (CLI, MCP)

`vite` (^8, MIT) is a peer dependency: the project installs it. `@napi-rs/canvas`'s native
binding is built on Skia (BSD-3-Clause).

Besides `@shaderera/core` 0.1.4 (MIT):

- **MIT:** @hono/node-server 2.1.5, @jridgewell/sourcemap-codec 1.6.0, @modelcontextprotocol/sdk
  1.32.1, @napi-rs/canvas-win32-x64-msvc 1.0.10, @napi-rs/canvas 1.0.10,
  @oxc-parser/binding-win32-x64-msvc 0.153.0, @oxc-project/types 0.153.0, accepts 2.0.0, ajv-formats
  3.0.1, ajv 8.20.0, body-parser 2.3.0, bytes 3.1.2, call-bind-apply-helpers 1.0.2, call-bound
  1.0.4, content-disposition 2.0.1, content-type 1.0.5, content-type 2.1.0, cookie-signature 1.2.2,
  cookie 0.7.2, cors 2.8.6, cross-spawn 7.0.6, debug 4.4.3, depd 2.0.0, dunder-proto 1.0.1, ee-first
  1.1.1, encodeurl 2.0.0, es-define-property 1.0.1, es-errors 1.3.0, es-object-atoms 1.1.2,
  escape-html 1.0.3, etag 1.8.1, eventsource-parser 3.1.1, eventsource 3.0.7, express-rate-limit
  8.7.1, express 5.3.0, fast-png 8.0.0, fast-deep-equal 3.1.3, fflate 0.8.3, finalhandler 2.1.1,
  forwarded 0.2.0, fresh 2.0.0, function-bind 1.1.2, get-intrinsic 1.3.0, get-proto 1.0.1, gopd
  1.2.0, has-symbols 1.1.0, hasown 2.0.4, hono 4.13.13, http-errors 2.0.1, iconv-lite 0.7.3,
  iobuffer 6.0.1, ip-address 10.7.4, ipaddr.js 1.9.1, is-promise 4.0.0, jose 6.2.12,
  json-schema-traverse 1.0.0, magic-string 1.4.3, math-intrinsics 1.1.0, media-typer 1.1.1,
  merge-descriptors 2.0.0, mime-db 1.54.0, mime-types 3.0.2, minisearch 7.2.0, ms 2.1.3, negotiator
  1.1.0, object-assign 4.1.1, object-inspect 1.13.4, on-finished 2.4.1, oxc-parser 0.153.0, parseurl
  1.3.3, path-key 3.1.1, path-to-regexp 8.4.2, pkce-challenge 5.0.1, proxy-addr 2.0.8, range-parser
  1.3.0, raw-body 3.0.2, require-from-string 2.0.2, router 2.2.0, safer-buffer 2.1.2, send 1.2.1,
  serve-static 2.2.1, shebang-command 2.0.0, shebang-regex 3.0.0, side-channel-list 1.0.1,
  side-channel-map 1.0.1, side-channel-weakmap 1.0.2, side-channel 1.1.1, statuses 2.0.2,
  toidentifier 1.0.1, type-is 2.1.0, unpipe 1.0.0, vary 1.1.2, wgpu-matrix 3.4.2, zod 4.6.7.
- **BSD-3-Clause:** @webgpu/types 0.1.74, diff 8.0.4, fast-uri 3.1.8, jpeg-js 0.4.4, qs 6.16.1.
- **Apache-2.0:** comlink 4.4.2.
- **ISC:** inherits 2.0.4, isexe 2.0.0, once 1.4.0, setprototypeof 1.2.0, which 2.0.2, wrappy
  1.0.2, zod-to-json-schema 3.25.2.
- **BSD-2-Clause:** json-schema-typed 8.0.2.

The agent skills (`shaderera`, `shaderera-plugins`) and the Claude Code plugin are in
`plugins/shaderera/` in the repository, MIT. `create-shaderera` copies them into every project.

## Development only

Not shipped and not bundled: typescript 6.0.3 (Apache-2.0), @biomejs/biome 2.5.14 (MIT OR
Apache-2.0), @types/* (MIT), vite 8.3.0 (MIT) as the workspace's build tool.

## Test fixtures

The fixtures in `apps/cli` are not published (`files` leaves out `dist/**/fixtures`). They install
`three` 0.186.1 (MIT), `webgpu` 0.6.2 (MIT; Dawn BSD-3-Clause) and `@napi-rs/canvas` 1.0.10 (MIT),
and carry Noto Sans and Noto Sans Thai (SIL OFL 1.1, `OFL.txt` beside the fonts).

## Plugins

The official plugins in `packages/plugins/` are MIT code, written for Shaderera; `add` copies them
into a project, where they are the project's own. Some declare npm packages the copied code
imports (`requires.packages`): `three` 0.186.1 (MIT), `fast-png` 8.0.0 (MIT), `jpeg-js` 0.4.4
(BSD-3-Clause), `@types/three` 0.186.0 (MIT), `opentype.js` 2.0.0 (MIT), `earcut` 3.2.3 (ISC),
`@napi-rs/canvas` 1.0.10 (MIT), `@huggingface/transformers` 4.3.1 (Apache-2.0).

`@huggingface/transformers` (`audio-listen`) brings `onnxruntime-node` 1.30.0 (MIT) and `sharp`
0.35.5 (Apache-2.0) into the project that adds it. `sharp`'s prebuilt binary
(`@img/sharp-win32-x64` 0.35.5) carries libvips under LGPL-3.0-or-later, as a separate shared
library. None of Shaderera's packages depends on it. The rest of its tree is MIT, Apache-2.0,
BSD-3-Clause (protobufjs, global-agent), ISC and `MIT OR CC0-1.0`.

### What the plugins' tools need

Some plugins' tools run outside the project's npm packages. The person installs what they need,
and their models are the person's own download. The plugin's README names each. None of it ships
in a Shaderera package or a plugin.

| Plugin | Installed by the person | Downloaded on first use |
|---|---|---|
| `review-shots` | Python: PySceneDetect 0.7 (BSD-3-Clause), OpenCV (Apache-2.0), numpy (BSD-3-Clause) | TransNet V2's weights (MIT, Copyright (c) 2020 Tomáš Souček), 30 MB from `github.com/soCzech/TransNetV2` at commit `85cef72`, checked by sha256 |
| `review-picture-reuse` | Python: OpenCV (Apache-2.0), numpy (BSD-3-Clause) | none |
| `image-regions` (`regions-sam.py`) | Python: Meta's `sam3` (SAM License), PyTorch (BSD-3-Clause), einops (MIT), pycocotools (BSD-2-Clause), psutil (BSD-3-Clause), on Windows triton-windows (MIT) | SAM 3.1's weights (Meta's SAM License, accepted on Hugging Face), 3.3 GB |
| `audio-listen` | ffmpeg | CLAP, `Xenova/larger_clap_general` at revision `d78c399` (ONNX of `laion/larger_clap_general`, Apache-2.0), about 780 MB |
| `audio-voice-repace` | ffmpeg; `--tempo` needs one built with librubberband (GPL-2.0-or-later) | none |

`review-shots` runs TransNet V2's network in numpy from that checkpoint. It installs neither
TensorFlow nor PyTorch. The SAM License is not an open-source licence: `image-regions` says so,
and the person accepts it before the weights download.

The media plugins are fonts under SIL OFL 1.1, each with its OFL text beside the font files:

| Plugin | Font |
|---|---|
| `font-ibm-plex-mono` | IBM Plex Mono (IBM) |
| `font-ibm-plex-sans` | IBM Plex Sans (IBM) |
| `font-stix-two-text` | STIX Two Text |
| `font-instrument-serif` | Instrument Serif |

## Copied code check

No Remotion and no HyperFrames code is copied. A search of `apps/` and `packages/`
(excluding `node_modules`) for their copyright headers (`Copyright … Remotion`, `Jonny Burger`,
`HeyGen`, `hyperframes`) finds nothing.
