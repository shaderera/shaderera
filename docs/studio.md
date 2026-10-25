# Studio

The studio is a page on shaderera.com, `https://shaderera.com/studio/<id>`, for making a film whose
project is on your own machine. It drives `shaderera studio`, the local bridge, which runs on
your machine for as long as the command runs. The project, its code and its renders stay on your
machine until you share the film.

This is protocol v1: the contract between the studio page and the bridge. v1 sends a file
through the relay in chunks; v0 sent it in one frame, and the two do not pair (the key's `info`).

```
npx shaderera studio [--connect <id>] [--site <origin>] [--api <origin>] [--origin <dev origin>]...
                     [--no-open] [--json]
```

- **Without `--connect`**, it makes a studio session id.
- **With `--connect <id>`**, it takes the id a studio page made. `<site>/studio` makes an id and
  shows the command to give your agent: `npx shaderera@latest studio --connect <id>`.
- **Either way, it opens `<site>/studio/<id>#<nonce>`** in your default browser
  (`?from=web#<nonce>` with `--connect`, for the page's `opened` count), and pairs only with the
  page that holds that nonce (below). From the web, that is a new tab: the page that
  showed the command never pairs, and says the studio opened elsewhere once the new tab joins.
  `--no-open` prints the address instead, for you to open; keep it to yourself.
- **`--site <origin>`** is the site, the studio page and its relay: `https://shaderera.com` by
  default, else `SHADERERA_SITE`, as for `share`. It is https, or plain http on this machine only
  (`localhost`, `127.0.0.1`).
- **`--api <origin>`** is the films API Share sends films to, as `share --api`:
  `https://api.shaderera.com` by default, else `SHADERERA_API`. You sign in to it with
  `shaderera login --api <origin>`.
- **`--origin <origin>`** (repeatable) adds a page origin the bridge answers, for developing the
  page on another origin than the relay's.
- **`--json`** prints one JSON line per event in place of the prose, for an agent (below).
- **`--root`, `--host`, `--trusted` and `--timeout`** are the common flags. The last three apply
  to the renders the page asks for, and to a share's poster and loop.

It runs until Ctrl-C. Once paired, it keeps serving the page even if the relay closes, and
rejoins the relay when it was dropped (below). Ctrl-C ends the session: the page says the CLI
disconnected.

When the page closes, the CLI says so only if no page comes back within 10 seconds. A reload comes
back sooner (a new `page-hello`, or a request to the bridge, directly or through the relay), and
the CLI says "the studio page reloaded" instead.

**For agents: `--json`.** Run `shaderera studio --json` in the background, give the person the
`url` event's address (or let the command open it), and read the events. stdout is one JSON object
a line, `{event, ...}`:

| Event | Fields | When |
|---|---|---|
| `notice` | `text` | the first `studio` on this machine: the telemetry notice |
| `url` | `url`, `id`, `opened`, `project`, `bridge`, `site`, `api` | the bridge is up; `opened` is false with `--no-open` |
| `paired` | | the page the CLI opened paired |
| `page-closed` | | the page closed and did not come back within 10 s |
| `resumed` | | the page came back within 10 s (a reload) |
| `mismatch` | `update` (`page`, `cli`), `text` | the page speaks another protocol: which side to update (below) |
| `relay` | `state` (`dropped`, `back`, `closed`), `code` with `closed` | the relay dropped the CLI, let it back, or closed for good once paired (the bridge still serves) |
| `changed`, `job`, `log`, `share` | as on `/events` (below) | the bridge's events. `changed` can come before `paired`: the bridge watches the files from its start |
| `ended` | `exitCode`, `error?` | the command ends: Ctrl-C (`0`), or the relay refused an id never paired, or the page is newer than the CLI (`2`, with why) |

A flag the command does not take, or a folder that is not a project, is still an error on stderr,
with exit code 2, before any event.

**Against a local site.** Run the site's dev server, for example on `http://127.0.0.1:5197`,
then, in a project:

```
npx shaderera studio --site http://127.0.0.1:5197
```

Add `--api <origin>` to share to a local films API as well, for example
`--api http://127.0.0.1:5193`, after `shaderera login --token <token> --api http://127.0.0.1:5193`.

## Ids and origins

- **A studio session id** is 20 characters from `abcdefghjkmnpqrstuvwxyz23456789`. The page lives
  at `<site>/studio/<id>`.
- **The pairing nonce** is 16 random bytes, base64url, new for each run of the command. The CLI
  puts it in the address's fragment, `<site>/studio/<id>#<nonce>`, which the browser never sends
  to a server. The page keeps it in this tab's `sessionStorage` until it pairs, so a reload of a
  waiting page still pairs, and takes it off the address.
- **Expiry.** An id expires when no CLI has paired with it within 10 minutes of its first
  connection. Once paired, it is used: no second CLI can pair with it.

## Pairing through the relay

The relay is a WebSocket on the site, one per id, with JSON text frames:
`wss://<site>/studio/relay/<id>?role=page|cli` (`ws://` for an http site).

1. **The page connects** with `role=page`.
2. **The CLI connects** with `role=cli`. The relay forwards `{type:"cli-joined"}` to the page.
3. **The page sends `{type:"page-hello", pub, protocol}`**: an ECDH P-256 public key, raw
   (uncompressed, 65 bytes), base64url, and the protocol it speaks, `1`. It sends it when it
   connects and again on every `cli-joined`. A page with no nonce sends nothing and waits.
4. **The CLI replies `{type:"cli-hello", pub, protocol, version, os, telemetry}`** to every
   `page-hello`.
   - `protocol` is the protocol it speaks, `1`. A hello without one is v0.
   - `pub` is its own key, the same for the life of the command.
   - `version` is the CLI's version.
   - `os` is Node's `process.platform`: `win32`, `darwin`, `linux`.
   - `telemetry` is false when telemetry is turned off.
   - **Another protocol on either side** never pairs (the keys differ by `info`, below), so each
     side says in one line which side is older and what to update, instead of waiting:
     - The CLI still replies `cli-hello`, with its `protocol`, and takes no proof from that page.
       For an older page it says to reload the page, and waits for the reload; for a newer page
       it says to update the CLI (`npm i shaderera@latest`) and ends, exit code 2.
     - The page, hearing a `cli-hello` of another protocol, says to update the CLI or to reload
       the page, and stops.
5. **Both sides derive one key.** ECDH gives 256 bits, which go through HKDF-SHA-256 with:
   - `salt` = the id's UTF-8 bytes;
   - `info` = `"shaderera-studio-v1"`.

   The result is an AES-256-GCM key.
6. **The page proves the nonce: `{type:"page-proof", iv, box}`.**
   - `box` is the UTF-8 JSON `{"nonce":"<the nonce>"}`, sealed with the session key as below.
   - The CLI ignores a proof that does not open with the key of the page's last `page-hello`, or
     holds another nonce. Until a proof matches, it sends no `bridge` and answers no `rpc`.
7. **The CLI sends `{type:"bridge", iv, box}`.**
   - `iv` is 12 random bytes.
   - `box` is the AES-GCM ciphertext, tag included, of the UTF-8 JSON `{"port":n,"secret":"<32 hex>"}`.
   - Both are base64url. The page also accepts plain base64.
   - The relay sees only ciphertext.
8. **The page decrypts it and sends `{type:"paired"}`.** The relay marks the id used. It takes
   `paired` only while a CLI is connected that has sent `bridge`.

**The relay's rules:**
- It forwards every frame from one side to the other as it is. It stores only when it first saw
  the id, whether the id is used or ended, and the SHA-256 of each resume token.
- When a side closes, it sends `{type:"cli-left"}` or `{type:"page-left"}` to the other side.
- **Close codes.** It closes a socket with:
  - `4001 expired`: the sockets on an id no CLI paired with in time;
  - `4002 used`: a second CLI, before or after pairing, or one with a wrong resume token;
  - `4003 taken`: a page once the id is paired, without its resume token;
  - `4004 ended`: a resume token once the session is over.
- **Before pairing, a second page replaces the first**, so reloading a waiting page works.
- **Resume tokens.** On `paired`, the relay sends the page and the CLI each
  `{type:"resume", token}`: 32 random bytes, hex, one for each.
  - The page keeps its token in this tab's `sessionStorage`, with the bridge's port and secret and
    the session key. A reload joins with `?role=page&resume=<token>` instead of pairing.
  - The CLI keeps its token in memory. When the relay drops it (a site deploy, the network: any
    close but 1000 and 4001–4004), it joins again with `?role=cli&resume=<token>`, after 1, 2, 4,
    8, 16 and then every 30 s, for as long as it runs. Its keys stay, so the page goes on.
  - A side with its token replaces that side's socket, if one is still there, and gets
    `{type:"resumed"}`; a CLI's return sends the page `cli-joined`.
- **The session ends** when the paired CLI closes with 1000 (Ctrl-C): the relay closes the page
  with `4004`. A paired CLI that dropped and does not come back within 10 minutes ends it too.
- **An id that expired or ended is forgotten**: the relay deletes what it stored, so the id then
  starts as a new one.

## The bridge

HTTP on `127.0.0.1:<port>` only, on a free port, while the command runs.

**Origins.** The bridge answers only `Origin: <site>` and the `--origin` values.
- Preflights (`OPTIONS`) from those get `204`, with:
  - CORS for that origin;
  - `Access-Control-Allow-Methods: GET, POST`;
  - `Access-Control-Allow-Headers: Authorization, Content-Type`;
  - `Access-Control-Allow-Private-Network: true`.
- Any other origin, or none, gets `403`. The one exception is the frame's navigation to
  `/runner`, which carries no `Origin`.

**The secret.** Every request carries `Authorization: Bearer <secret>`. Where a request cannot set
headers (EventSource, a frame), it passes `?s=<secret>` instead. A wrong or missing secret gets
`403`.

**Loopback.** The page never declares `targetAddressSpace: "local"`: a fetch declared `local`
fails for 127.0.0.1. It declares nothing, or `"loopback"`.

**The browser's permission.** Chrome asks before the page's first request to the bridge ("Access
other apps and services on this device", "Apps on device" in its site settings). The page reads
the permission first, and asks for a click (Connect) before that request when Chrome would ask.
- **Allowed, it is kept** for the site the page is on (its top-level origin) in that browser
  profile. It covers every port, studio and runner frame there, and Chrome does not ask again.
  Another origin asks again: `www.shaderera.com` is not `shaderera.com`, and neither is a
  `--site` or `--origin` value. So does each incognito or Guest session.
- **Closing the question counts as denied.** Chrome does not ask again, and the page uses the
  relay, where the preview does not play.
- **To allow it again:** open the site settings from the icon left of the address, and set "Apps
  on device" to Allow. The page moves from the relay to the bridge without a reload.

**Errors** are JSON: `{error}` with `400` for a bad request, `404` for no such route or job, and
`500` otherwise.

### `GET /info`

```json
{
  "version": "…",
  "film": { "title": "…", "manifest": { … }, "variants": { … }, "sizes": { … }, "schema": { … } },
  "telemetry": true
}
```

- `version` is the running CLI's version, from its package.json.
- `title` is package.json's `name`, else the folder's name.
- `manifest` is shaderera.json as the CLI and the runner read it.
- `variants` is shaderera.json's `variants`, in its own shape (`{}` when there are none): name →
  `{ label?, width?, height?, duration?, fps?, params? }`.
- `sizes` is each variant's output as a host opens it, the film's own values filled in: name →
  `{ width, height, duration, fps }` (`{}` when there are none), for a page that lays out one
  frame a variant.
- `schema` is shaderera.json's `params` schema, or `null`.
- Each request reads the project again, so an agent's edit to shaderera.json shows.

### `GET /runner?s=<secret>&parent=<page origin>[&variant=<name>]`

The project's runner page, for the page to frame with packages/ui's `connect({ runnerUrl })`. That
frame is sandboxed with `allow-scripts` alone, and the page talks to the runner worker over the
port the frame posts, as with the web player.

- **`variant`** names a variant in shaderera.json's `variants`: that frame's runner opens the film
  as that variant whenever `open` names none (an `open` that names one still wins). Without it,
  the runner opens the film itself. An unknown name is `400`. A page that shows several variants
  frames one runner a variant and drives them on one timeline itself; each frame is a runner of
  its own.

- **The bridge redirects (`302`) to the runner page**, keeping the query but `s`. The runner page
  is served by the project's own Vite, on another port of 127.0.0.1, under a path that is itself a
  secret: `/runner/<32 hex>/__shaderera/runner.html`.
  - Outside that path, the runner server refuses everything (`403`).
  - Under it, every file is served with `Access-Control-Allow-Origin: *` and
    `Cross-Origin-Resource-Policy: cross-origin`, because a sandboxed frame's requests come from
    an opaque origin (`Origin: null`). The path is the check.
  - The page needs only `/runner?s=…`. Where the redirect goes is the bridge's own business.
- **Which page gets the port.**
  - The runner page lists the site's origin and the `--origin` values in
    `<meta name="shaderera-parents">`.
  - Its CSP's `frame-ancestors` lists the same origins.
  - It posts its port only to the origin `?parent=` names, when that origin is listed, else to
    the first listed. The browser delivers it only to a parent page of that origin.
- **The frame's messages** go to that origin, as the web player's do:
  - `{shaderera:"runner"}` with the port;
  - `{shaderera:"error", message}` when the worker fails to load;
  - `{shaderera:"reloading"}` before it unloads.
- **The page reloads the frame on `changed`.** The frame does not reload itself on edits. Vite
  may reload it once while it optimises dependencies: it then posts `reloading` and a new
  `runner`.
- Other query parameters (a revision counter to force a reload) are passed through and ignored.

### `GET /events?s=<secret>`

Server-Sent Events, each a JSON `data:` line, with a comment every 15 s to keep the stream open:

| Event | When |
|---|---|
| `{type:"changed", revision}` | the project's files changed: the 16-hex revision id `shaderera save` would give them |
| `{type:"job", id, state, progress, error?}` | a render was queued, started, progressed or ended |
| `{type:"log", level, text}` | `info`, `warn` or `error`: a render's start and end, share lines, watcher problems, the runner's build errors, and the framed film's console warnings and errors (not a browser extension's) |
| `{type:"share", film, version, url}` | a share sent the film: its id, the new version and its page |

- **What counts as a change.** A change counts only when it touches the files a revision holds:
  not `out/`, `versions/`, `.shaderera/` or `.claude/` at the root, and not `node_modules/` or
  `.git/` anywhere, and not a file that holds secrets (`.env`, `.npmrc`, … as `save` lists them in
  [cli.md](cli.md#versions-and-jobs)). A change that leaves the revision the same sends nothing.
- **Job states** are `queued`, `running`, `done` and `failed`. `done` and `failed` end a job.
  `progress` runs from 0 to 1.

### `POST /render {variant? | variants?, params?, format, t?}` → `{job}` or `{jobs}`

Renders on your machine, with the CLI's own hosts and ffmpeg, one job at a time in the order
asked.

- **`variant`** is a name in shaderera.json's `variants`. Leave it out for the film itself. The
  answer is `{job}`.
- **`variants`** is a list of those names, for several at once, in place of `variant` (not with
  it). Every name is checked first: an unknown one is `400` and nothing is queued. The answer is
  `{jobs}`, one job a name (a name given twice renders once), queued in the order given, each
  with its own `job` events and file. `params`, `format` and `t` apply to every one.
- **`params`** go over the defaults and the variant's. An undeclared name fails the job.
- **`format`** is one of:
  - `"mp4"`: H.264, the same file `shaderera render` makes;
  - `"mov"`: ProRes 422 HQ;
  - `"png"`: one still, at `t` seconds (`0` by default), inside the film.
- **The project is saved as a revision first**, and a video is tagged with it, as `render` does.
- **The file stays in the project**, as `out/studio/<project>[-<variant>]-<job>.<mp4|mov|png>`.
  In the variant's name, anything but letters, digits, `_`, `.` and `-` becomes `_` (`16:9` is
  `16_9`).

### `GET /render/<job>/file`

The job's file, streamed for the page to save, with:
- `Content-Type`: `video/mp4`, `video/quicktime` or `image/png`;
- `Content-Disposition: attachment; filename="…"; filename*=UTF-8''…`, exposed to the page.
  `filename` is the name in ASCII, with `_` for anything else; `filename*` is the name itself,
  percent-encoded UTF-8 (RFC 6266), for a project named in any script.

A job that is not done gets `409`. An unknown one gets `404`.

### `POST /share {title?}` → `{film, version, url}`

Runs `shaderera share` as you, with your own sign-in (`npx shaderera login`), to `--api`. Pressing
Share in the page is the confirmation. A new film is titled `title`, else as `share` titles it.
`url` is the film's page, as `share` prints it; a poster or loop ffmpeg could not make is a
`warn` log line, and a film that did not render is refused, as `share` refuses it.

- **Not signed in** (no token for `--api`, or it refused the token): `401` with
  `{error:"login", command:"npx shaderera login"}`. The page shows the command to run.
- **Anything else** that stops the share (no licence, a player that does not build, a film that
  does not render, a version over the API's limits, the API unreachable): `500` with `{error}`.

## The relay fallback

When the direct `GET /info` fails (Safari and Brave block a public page from calling 127.0.0.1,
and Chrome does if the person declines), the page sends the same requests through the relay,
sealed with the session key. The page then shows "Connected through shaderera.com (your browser
blocks local access)".

| From | Frame | The box holds |
|---|---|---|
| page | `{type:"rpc", id, iv, box}` | `{method, path, body?}`: `path` as above, without `s` |
| CLI | `{type:"rpc-result", id, iv, box}` | JSON: `{status, body}`; a file's head: `{status, type, name, size, chunks}` |
| CLI | `{type:"rpc-chunk", id, seq, iv, box}` | a file's bytes `seq` (0, 1, …), as they are, not JSON (below) |
| CLI | `{type:"event", iv, box}` | the same event JSON as on `/events` |

- **`id`** is the page's own string, echoed in the result.
- **Events** go through the relay once the page has sent its first `rpc`.
- **A file comes in chunks.** The Worker takes WebSocket messages of 32 MiB at most, and a film's
  mp4 or mov is often larger. After the head, the CLI sends `chunks` frames `rpc-chunk`, in order,
  each holding up to 512 KiB of the file (a frame stays under 1 MiB). A chunk's box is the bytes
  sealed with AES-GCM under the session key and a fresh iv, with the additional data
  `"<id>:<seq>"`, so a chunk opens only in its own place: the relay can neither reorder chunks nor
  move one to another request. The page joins them in order; their length is `size`. A file that
  cannot be read is `{status:500, body:{error}}` with no chunks. A page that hears no chunk for a
  while gives up on the file.
- **`/runner` is not available through the relay**: a frame cannot go through it. It answers
  `400`. The preview needs the direct connection to 127.0.0.1; the page says so, and Export (any
  size, in chunks) and Share still work.
- **A box that does not open** answers `{status:400, body:{error:"box"}}`.

## Telemetry

The studio page reports usage counts to shaderera.com, which stores them in PostHog. The CLI
sends nothing itself.

- **What the page sends.** It POSTs `{session, event, data}` to `<site>/studio/telemetry`, and
  the site stores each count in PostHog with no person profile and no IP; the studio session id is
  its only id. The events:
  - `opened` (`from: web|cli`): `web` when the session began at `<site>/studio`;
  - `paired` (the CLI's version, OS, `direct|relay`);
  - `edit`: a count of `changed` events;
  - `render`: format, seconds, wall time;
  - `export`;
  - `share`;
  - `error`: a code only.
- **What it never sends:** code, file names, params values, frames or titles.
- **Turning it off.** Either of these makes `telemetry` false in `cli-hello` and `/info`, and the
  page then sends nothing:
  - `SHADERERA_TELEMETRY=0`;
  - `shaderera telemetry off`.

  The page holds its events until one of those reports `telemetry`.

`shaderera telemetry off|on|status` keeps the choice in `~/.shaderera/config.json`.
`SHADERERA_TELEMETRY=0` turns it off whatever that file says. A config that cannot be read counts
as off, and is never overwritten: fix it or delete it. The first `shaderera studio` prints
a notice saying all of this, once, and notes in the same file that it did.
