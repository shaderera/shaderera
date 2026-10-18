# The web player

A film's web player is its runner (the page and worker where the browser host runs the source)
built as static files for that one film. Any static host can serve it, and a page on another
origin can play it in a sandboxed frame. `shaderera share` builds it on your machine into
`.shaderera/player/` and sends it beside the source ([cli.md](cli.md#shadereracom-login-share-fork)).
The site stores and serves it and builds nothing.

## What it holds

```
runner.html           the page a site frames; it starts assets/bridge.js
assets/bridge.js      starts the worker and hands the framing page a port to it
assets/worker.js      the runner worker: the only caller of the film's Source
assets/chunks/*       the film's entry, its npm dependencies and the engine's shared code
assets/THIRD-PARTY-NOTICES.txt  the licence notices of every package bundled in assets/
files/<path>          the film's files, as share sends them, for io.read
media/<path>.mp4      for each video among them, an H.264 proxy io.video decodes
media/<path>.json     its width, height, fps and frame count, as io.video reads the original
bakes/<name>/<frame>  each bake's frames, checked against its stamp, for io.bake
bakes/<name>.json     their file names in order
```

Every URL in it is relative, so it can be served under any path. Nothing in it names the folder
it was built in, and `shaderera.json`'s `stamp` is applied only when the manifest sets it. The
chunks have no hash in their names, so `assets/worker.js` is usually the same file for every film
one version of `shaderera` builds: a site that stores files by their hash keeps it once.

A static player has no CLI process behind it, so its worker answers what the CLI would:
- `io.read`: the film's files in `files/`.
- `io.video`: the proxy. It has the original's frames, converted to H.264 (yuv420p, BT.709, a
  keyframe every 15 frames, no B-frames); the build checks its frame count and size against the
  original. The worker decodes it with WebCodecs, through Mediabunny. The frames are close to the
  CLI's, not the same bytes: the browser's colour conversion differs from ffmpeg's (about 32 dB
  PSNR on a test pattern's saturated edges).
- `io.bake`: the bake's frames, the same bytes as the CLI reads. A bake that was never made, is
  stale or has a changed frame fails the build, naming `shaderera bake <name>`.
- `io.cache`: kept in memory for the page's life.

The build needs ffmpeg and ffprobe only for a film with video (`.mp4`, `.m4v`, `.mov`, `.webm`,
`.mkv`). A player opens its own film, never a saved revision. A film with `manifest.dom` draws
it only in a Chrome with HTML-in-Canvas (`--enable-features=CanvasDrawElement`).

## Serving it

- **Every file** with `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy:
  cross-origin`. A frame sandboxed without `allow-same-origin` has an opaque origin, so its
  module scripts, its worker and their fetches are all cross-origin; without the header nothing
  loads.
- **The page**, `runner.html`, with a Content-Security-Policy like the runner server's. `'self'`
  means nothing to an opaque origin, so the player's own origin is spelled out, and the worker
  starts from a `data:` URL:

  ```
  default-src 'self';
  script-src 'self' <player origin> 'wasm-unsafe-eval';
  worker-src 'self' <player origin> data:;
  connect-src 'self' <player origin>;
  img-src 'self' <player origin> data: blob:;
  font-src 'self' <player origin> data: blob:;
  style-src 'self' 'unsafe-inline';
  frame-ancestors <the site's origins>
  ```

- **Types**: `.js` as `text/javascript`, `.json` as `application/json`, `.mp4` as `video/mp4`;
  the film's own files by their extension.

Every file but `runner.html` can be cached for good: a new version is a new set of files.

## Framing it

```html
<iframe sandbox="allow-scripts" src="https://player.example/v/<version>/runner.html?parent=https://site.example"></iframe>
```

The frame draws nothing. The site takes the bridge's port and calls the runner over it with
[Comlink](https://github.com/GoogleChromeLabs/comlink): `open`, `render(t)`, `inspect(t)`,
`pixels(t)`, `audio()`, `captions()` and the rest of the runner's API. `render(t)` returns each
layer as an `ImageBitmap`, which the site draws itself; soloing or muting a layer is the site
choosing which to draw.

## The bridge

The bridge is the only code that talks across the frame, with `postMessage`.

**Which pages may have the port.** `runner.html` lists the origins allowed to frame the player
and drive it, in `<meta name="shaderera-parents" content="<origin> <origin>…">`. `share` writes
the site it sends to; the build's `parents` option takes others, and `https://shaderera.com` is
the default. The bridge picks one: the origin `?parent=` names when it is in the list, else the
first. It posts the port to that origin only, so the browser delivers it only to a parent page
of that origin. A page of any other origin that frames the player gets nothing (the site's
`frame-ancestors` should refuse it before that).

**From the player to the site:**

| Message | When |
|---|---|
| `{ shaderera: 'runner' }`, with one `MessagePort` | once the worker is started: the port to the runner (Comlink) |
| `{ shaderera: 'error', message }` | the worker failed to load (a missing file, a CSP refusal) |
| `{ shaderera: 'reloading' }` | the page is about to unload; a new port follows if it comes back |

All three go to the chosen parent origin only. The frame's own origin is opaque, so these
arrive with `event.origin` `"null"`: the site checks `event.source` is its frame's
`contentWindow`.

**From the site to the player:**

| Message | What the player does |
|---|---|
| `{ shaderera: 'file', name: 'local:<id>/<file name>', file: Blob }` | hands the file to the worker, where `io.video` opens it by that name |

A viewer can try their own clip this way: the film's param names `local:<id>/<file name>`, and
the site posts the file it was given. The bridge takes it only when `event.source` is its parent
window and `event.origin` is the chosen parent origin, and only under a `local:` name; anything
else is ignored. The file is decoded in the viewer's browser and never sent anywhere. `io.video`
reads its size, fps and frame count from the file itself, and waits up to 10 s for it to arrive.

## The runner's host hook

Experimental: it may change in any release. The web player is the runner worker with two things
changed through `configureRunner`, which the runner worker module exports. Another host that builds the runner into a worker of its own can
do the same, once, before the page connects:

```ts
import { configureRunner } from 'shaderera/dist/runner/worker.js'

configureRunner({
  // Where io.read finds the film's files: an absolute URL ending in /.
  files: new URL('../files/', import.meta.url).href,
  // What answers io.video, io.cache and io.bake, in place of the CLI's process.
  ask: {
    videoOpen: async (path) => ({ width, height, fps, frames }),
    videoFrame: async (path, index) => rgbaBytes,  // straight RGBA, full range, 4 bytes a pixel
    videoClose: async (path) => {},
    cacheGet: async (hash) => bytesOrNull,
    cachePut: async (hash, bytes) => {},
    bakeOpen: async (name) => ({ frames }),
    bakeFrame: async (name, index) => bytes,         // the frame file's bytes as they are
  },
})
```

Without it, the runner asks the CLI's process through the runner server, as the browser host
does. The Node host asks the same questions over IPC and is not affected.

## Licences

`assets/worker.js` bundles [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0),
unmodified, with its licence notice kept in each of its files; its source is on npm and GitHub.
The rest of the engine's code in the player is MIT, and the film's own code and dependencies are
under the film's licence.

The build writes `assets/THIRD-PARTY-NOTICES.txt`, and `runner.html` names it. It holds the
notices of every package the bundler put in `assets/`: the engine's (`shaderera`,
`@shaderera/core`), Mediabunny, Comlink, fast-png and the rest of what they import, the bundler's
runtime helpers (Vite, Rolldown), and the film's own npm dependencies, which are bundled the same
way and carry the same duty. The film's own code is the author's and is left out. The list comes
from the modules the bundler included, not from a list kept by hand. For each package, sorted by
name: its name, version and `license` from its `package.json`, its `LICENSE`, `LICENCE` or
`NOTICE` files, and the licence headers of its bundled files, which the bundler drops from the
code. Two builds of one film write the same bytes.
