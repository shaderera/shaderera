# 0024: A player origin per version, so the WebGPU shader cache works

2026-10-23. Decided by the owner (#346).

**Context.** shaderera.com plays a shared film from its version's web player (docs/player.md),
served by the player Worker at `https://shadererausercontent.com/v/<sha256>/runner.html` under
`Content-Security-Policy: sandbox allow-scripts` and framed with `sandbox="allow-scripts"`. That
gives the frame an opaque origin, and Chrome never caches the WebGPU shaders an opaque origin
compiles. In Chromium's source:
- `content/browser/gpu/gpu_process_host.cc`, `GetIsolationKey`: the GPU process keys its shader
  cache on the frame's `NetworkIsolationKey`, by its `ToCacheKeyString()`;
- `net/base/network_isolation_key.cc`, `IsTransient`: a key with an opaque origin is transient,
  and its cache key string is empty, so nothing is stored for it.

So every visit compiles every pipeline cold. MATTER's `evaluate`, measured:

| | first load | next load |
|---|---|---|
| a normal origin | 8 s | 52 ms |
| `sandbox allow-scripts` | 11.8 s | 11.8 s, on every load |

A version's files never change, and its id is the sha256 of its file list, so a version is a
natural unit for an origin. Google hosts user content this way ("Securely hosting user data in
modern web applications", bughunters.google.com): each piece of content on a unique subdomain of a
sandbox domain that is on the Public Suffix List, so no two pieces share an origin and none shares
a site with the product.

**Decision.**

1. **A version's player has its own origin:** `https://<label>.shadererausercontent.com/`, where
   `<label>` is the version's sha256 (its 32 bytes) in lowercase RFC 4648 base32 without padding.
   That is 52 characters, which fits one DNS label (63 at most) where the 64 hex characters do
   not. A label names one version in one spelling only: a label whose trailing bits are not zero
   names none.
2. **It stays sandboxed, with a real origin.** The Worker's policy ends `sandbox allow-scripts
   allow-same-origin`, and the site frames it with `sandbox="allow-scripts allow-same-origin"`.
   The origin is real, so Chrome keeps the shaders, and it is that version's alone, on another
   registrable domain than shaderera.com, so the film's code reaches neither the site nor another
   version's storage. The rest of the policy (`frame-ancestors` the site's origins, no forms, no
   top navigation, every other page as text) does not change.
3. **The old paths go.** `/v/<sha256>/...` is deleted outright, with no redirect, and the apex
   and workers.dev serve no version. A version needs no change: its player's URLs are all
   relative (docs/player.md), so it plays at its origin's root as it did under `/v/<sha256>/`.
4. **The API returns the new URLs** (the fixtures in `apps/cli/src/cli/fixtures/api` change once,
   as one breaking change, before 1.0):
   - `POST /films/{film}/versions`: `url` is `https://<label>.shadererausercontent.com/runner.html`;
   - `GET /films/{film}`: `player` is the latest version's origin, and absent when that version has
     no player.

   The CLI only prints these URLs, so 0.1.5 keeps working.
5. **Listing `shadererausercontent.com` on the Public Suffix List is a later step.** Until it is
   listed, every version is on one site, `shadererausercontent.com`:
   - a cookie one version sets for `Domain=shadererausercontent.com` reaches the others (storage,
     caches and everything else origin-scoped do not);
   - the shader cache is keyed by site, so versions share it under one framing site; shaders are
     the engine's and the films' public code, and the shared ones are compiled once.

   Once listed, each version is its own site: its cookies are its own, and so is its shader
   cache, so the engine's shared pipelines compile once per version.

**Consequences.**
- **Measured on this decision's build** (headless Chrome 156, the player Worker run locally on
  `<label>.localhost`, MATTER's version as shared): the first frame took 16.3 s cold, then 108 ms
  and 98 ms on the next loads, and 8.4 s then 110 ms across a restart of the browser with the same
  profile. Framed with `allow-scripts` alone, the same film took 17.5, 9.8 and 9.3 s. The bridge's
  worker starts from a `data:` URL (docs/player.md) and still gets the cache.
- **The site** frames `<origin>/runner.html` for a version and checks a message's `event.origin` is
  that origin, besides its `event.source`; files it posts to the frame go to that origin only.
- **DNS:** a proxied wildcard record and a Worker route on `*.shadererausercontent.com/*` (a Custom
  Domain can't be a wildcard). Cloudflare's Universal SSL covers the first level of subdomains.
- **Local:** `wrangler dev` sends every request on with the host of the route's zone, so the label
  is lost; the site's player is run through `unstable_startWorker`, which can leave the host alone,
  on `<label>.localhost` (Chrome sends every `*.localhost` to the machine).
- **The studio** (0021) frames the CLI's own runner on 127.0.0.1, whose origin is the CLI's
  bridge's too, so it keeps `sandbox="allow-scripts"` alone; it is not part of this decision.
- **Later:** the Public Suffix List entry (5), with its own review of what the site and the API
  set on `shadererausercontent.com`.
