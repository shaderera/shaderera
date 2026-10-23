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

   The CLI reads neither: `share` prints the version's `page` (the film on shaderera.com), and
   `fork` reads the film's ids, so 0.1.5 keeps working.
5. **`shadererausercontent.com` goes on the Public Suffix List (private section), and this is
   required, not a nicety.** Until browsers ship the listing, every version is on one site,
   `shadererausercontent.com`, and a film can take every other film away from a viewer:
   - **A cookie bomb (denial of service).** A film's code runs on its version's real origin, so
     it can set cookies with `Domain=shadererausercontent.com`: about 180 of 4 KB each. The
     browser sends them with every request to every version's host. Cloudflare answers `400
     Request Header Or Cookie Too Large` before the Worker runs, so from then on no film plays
     for that viewer, on shaderera.com or anywhere, until they clear the site data of
     `shadererausercontent.com`. Anyone who can share a film can do it to anyone who opens it.
   - **A timing leak.** The shader cache is keyed by site, so versions share it under one framing
     site: a film can time its own compiles of another film's pipelines and learn whether the
     viewer has played that film (a small leak of viewing history).

   Once listed, `<label>.shadererausercontent.com` is itself a registrable domain: a browser
   refuses a cookie for `Domain=shadererausercontent.com`, and each version has its own cookie
   jar and its own shader cache (the engine's shared pipelines then compile once per version).
   The submission is a pull request to github.com/publicsuffix/list with a `_psl` TXT record on
   the domain; the draft is in shaderera/shaderera.com (`plans/2026-10-23-public-suffix-list.md`).
   Browsers take the list in their releases, weeks to months after it is merged.

6. **The deploy waits on the owner.** Either the player moves before the listing ships, and the
   cookie bomb is an accepted risk until then, or it waits for the listing. What helps meanwhile
   is partial:
   - `Clear-Site-Data: "cookies"` on `runner.html` clears the cookies of the whole site, but only
     while a request still fits under Cloudflare's limit: it slows a bomb, it does not undo one.
   - Nothing at Cloudflare that we know of helps: the header limit is checked before Transform
     Rules and before the Worker, so neither can drop the `Cookie` header in time, and the
     Worker never sets cookies in the first place.
   - The site can recognise a player that never answers and tell the viewer to clear the site
     data of `shadererausercontent.com`: a way back, not a defence.
   - Keeping `allow-same-origin` off (the opaque origin) is the only full defence before the
     listing, and it is what this decision gives up.

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
- **The player Worker answers** only a host that is exactly `<label>.shadererausercontent.com`,
  and refuses (403) a request with `Service-Worker: script`, so no film can register a service
  worker that would answer its pages without the Worker's policy. The zone always uses HTTPS.
- **Before the deploy:** the owner's choice (6), and the Public Suffix List pull request (5).
