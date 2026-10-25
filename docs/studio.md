# Studio

The studio is a page on shaderera.com, `https://shaderera.com/studio/<id>`, for making a film whose
project is on your own machine. It drives `shaderera studio`, the local bridge, which runs on
your machine for as long as the command runs. The project, its code and its renders stay on your
machine until you share the film.

This is protocol v2: the contract between the studio page and the bridge. v2 adds the comments
on the film, the activity, the versions and runners on saved revisions
([ADR 0025](adr/0025-comments-and-activity-in-the-studio.md)). v1 had none of them, and v0 sent a
file through the relay in one frame. Pages and CLIs of different versions never pair (the key's
`info`): each says which side to update.

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

It runs until you stop it. Once paired, it keeps serving the page even if the relay closes, and
rejoins the relay when it was dropped (below). Stopping it ends the session: the page says the CLI
disconnected. It stops, cleanly, on:
- `shaderera studio --stop`, run in the same project (below);
- Ctrl-C, or SIGTERM;
- when its stdin is a pipe (an agent's): stdin closing, or the line `{"stop":true}` on it.

Killing the process (on Windows, any signal from another process kills it) skips all that: the
page hears only that the CLI left, and the relay keeps the session for a while in case it comes
back.

An id the CLI made itself that no page pairs with in 10 minutes expires (below). The CLI then
makes a new id and prints its address (a second `url` event, not opened), and goes on waiting. An
id from `--connect` belongs to the page that made it: when it expires, the command ends. So does an id
the relay expires well before 10 minutes (an older relay, or the wrong `--site`), exit 2: the CLI
does not make one id after another.

When the page closes, the CLI says so only if no page comes back within 10 seconds. Once paired,
a reload comes back sooner (a new `page-hello`, or a request to the bridge, directly or through
the relay), and the CLI says "the studio page is back" instead. A request in the 2 s before the
relay says the page left counts too: a reloaded page reaches 127.0.0.1 before the relay's word
does. A page said closed that comes back later (a reload that waited for Connect) is back as
well, once. Before pairing, a page that comes
back is simply the page that pairs.

**For agents: `--json`.** Run `shaderera studio --json` in the background, give the person the
`url` event's address (or let the command open it), and read the events. stdout is one JSON object
a line, `{event, ...}`:

| Event | Fields | When |
|---|---|---|
| `notice` | `text` | the first `studio` on this machine: the telemetry notice |
| `url` | `url`, `id`, `opened`, `project`, `bridge`, `site`, `api`; `expired`, `text` on a new id | the bridge is up; `opened` is false with `--no-open`. Again, with a new id, when no page came for the last one in 10 minutes: `expired` is that id |
| `paired` | | the page the CLI opened paired |
| `page-closed` | | the page closed and did not come back within 10 s |
| `resumed` | | once paired, the page came back: within 10 s (a reload), or later, after `page-closed` (a reload that waited for Connect) |
| `mismatch` | `update` (`page`, `cli`), `text` | the page speaks another protocol: which side to update (below) |
| `relay` | `state` (`dropped`, `back`, `closed`), `code` with `closed` | the relay dropped the CLI, let it back, or closed for good once paired (the bridge still serves) |
| `changed`, `job`, `log`, `share`, `comment`, `agent` | as on `/events` (below) | the bridge's events. `changed` can come before `paired`: the bridge watches the files from its start. A running job's progress comes at most every 10 % and 2 s, and every state change comes. `activity` is not sent: it is the agent's own record |
| `ended` | `exitCode`, `error?` | the command ends: stopped (`0`), or the relay refused an id never paired, or the page is newer than the CLI (`2`, with why) |

A flag the command does not take, or a folder that is not a project, is still an error on stderr,
with exit code 2, before any event.

**To stop it**, run `shaderera studio --stop` in the project (or with `--root`). The running
command sends `ended` and exits 0, and the page is told the session ended. `--stop` waits for it
to end, then exits 0. It also exits 0 when no studio runs for the project, and says so. It works
whatever stdin the running command has, on every OS. Closing a piped stdin, or writing
`{"stop":true}` to it, does the same.

**One studio a project.** A studio claims its project before its bridge starts. It makes
`.shaderera/studio/bridge.json` with its `pid`, adds its bridge's `port` and a stop `token` once
the bridge is up, and removes the file when it ends. The token is not the page's secret: it is good
for `POST /stop` and nothing else, so a process that reads the file cannot act as the page.
- **Only you can read it.** The folder is made private before any file is made in it, so every
  file is private from the moment it exists:
  - On macOS and Linux, the folder is mode 0700 and the file mode 0600.
  - On Windows, the folder's inherited permissions are replaced with one entry for your account,
    which the files in it inherit. A project outside your profile (`C:\work`) would otherwise
    inherit read access for every user of the machine.
- **A second `studio`** on a project whose studio is starting or running is refused (exit 2), and
  names `--stop`. Two started at once never both run: the file is made only if it is not there.
- **`--stop` on a studio still starting** waits until its bridge is up, then stops it.
- **A stale file** (its pid has ended, or its bridge does not answer) is removed, and counts as no
  studio. A file the CLI cannot read (another user's) is never removed: the command says so.
- **The CLI's request** to the bridge is `POST /stop`, without an `Origin`, carrying the token
  (below).

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
- **The session ends** when the paired CLI closes with 1000 (stopped): the relay closes the page
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
- Any other origin, or none, gets `403`. There are two exceptions, both without an `Origin`: the
  frame's navigation to `/runner`, and the CLI's own `POST /stop`.

### `POST /stop`

From the CLI only (`studio --stop`), with no `Origin` and the stop token from bridge.json (not the
secret, which `/stop` refuses): it answers `{stopping:true}`, and the command ends, as on Ctrl-C. A
page cannot send it: a browser always sends an `Origin` with a POST, and the relay does not carry
it.

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

**Errors** are JSON: `{error}` with `400` for a bad request, `404` for no such route, job or
file, and `500` otherwise. The error names the field or the file. A body over 1 MB is `400`, and
the bridge closes that connection after it.

### `GET /info`

```json
{
  "version": "…",
  "film": { "title": "…", "manifest": { … }, "variants": { … }, "sizes": { … }, "schema": { … } },
  "telemetry": true,
  "revision": "…",
  "head": "…",
  "listening": false,
  "api": "…"
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
- `revision` is the working tree's id now: the 16-hex id `shaderera save` would give it.
- `head` is the revision last saved or restored, or `null`.
- `listening` is true while an agent waits for comments (`shaderera comments --wait`): some
  waiter's file in `.shaderera/comments.wait/` was touched in the last 5 s.
- `api` is the films API Share sends to (`--api`), there only when it is not the default
  `https://api.shaderera.com`: a command the page shows to run the studio again keeps it.
- Each request reads the project again, so an agent's edit to shaderera.json shows.

### `GET /runner?s=<secret>&parent=<page origin>[&variant=<name>][&revision=<id>]`

The project's runner page, for the page to frame with packages/ui's `connect({ runnerUrl })`. That
frame is sandboxed with `allow-scripts` alone, and the page talks to the runner worker over the
port the frame posts, as with the web player.

- **`variant`** names a variant in shaderera.json's `variants`: that frame's runner opens the film
  as that variant whenever `open` names none (an `open` that names one still wins). Without it,
  the runner opens the film itself. An unknown name is `400`. A page that shows several variants
  frames one runner a variant and drives them on one timeline itself; each frame is a runner of
  its own.
- **`revision`** names a saved revision (from `/versions` or a comment): the runner plays that
  revision's files, from its frozen copy under `.shaderera/revisions/<id>/`, however the tree
  changed since. This is how the page compares a comment's revision with its fix. Its `variant`
  is one of that revision's. At most 2 such runners run besides the working tree's: a third
  closes the least recently used, once its frame has had 30 s to load. An id that is not 16 hex
  digits is `400`; one the project does not keep (unknown, or pruned) is `404`. The working tree's
  runner never reloads for them.
- **Without `revision`, the tree it frames is stored**, as an unlisted revision: its files and its
  revision, but no line in the log, so `versions`, `undo` and `restore` never see it. A comment on
  what the page shows then names a tree that exists, however the files change while the person
  writes. `prune` removes an unlisted revision no comment, job or bake names, once it is 10
  minutes old, whatever `--keep` says. Only a framed tree is stored, not every `changed` one.

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
| `{type:"changed", revision, files:{added, removed, changed}}` | the project's files changed: the tree's new id, and the files (paths as a revision names them) that changed since the last `changed` |
| `{type:"job", id, state, progress, error?}` | a render was queued, started, progressed or ended |
| `{type:"log", level, text}` | `info`, `warn` or `error`: a render's or a share's error, a share's warnings, watcher problems, the runner's build errors, and the framed film's console warnings and errors (not a browser extension's) |
| `{type:"share", film, version, url}` | a share sent the film: its id, the new version and its page |
| `{type:"activity", entry}` | an activity entry was added, by any process: the CLI, MCP or the bridge (`GET /activity`) |
| `{type:"comment", comment}` | a comment was made or changed, by any process: the whole thread, folded, with `stale`, as `GET /comments` gives it |
| `{type:"agent", listening}` | an agent started or stopped waiting for comments (`/info`'s `listening`) |

- **The files are the channel.** The CLI and MCP write `versions/comments.jsonl` and
  `.shaderera/activity.jsonl` themselves, with or without a studio running. The bridge watches
  both and sends what was added, within a second.
- **What counts as a change.** A change counts only when it touches the files a revision holds:
  not `out/`, `versions/`, `.shaderera/` or `.claude/` at the root, and not `node_modules/` or
  `.git/` anywhere, and not a file that holds secrets (`.env`, `.npmrc`, … as `save` lists them in
  [cli.md](cli.md#versions-and-jobs)). A change that leaves the revision the same sends nothing.
- **Job states** are `queued`, `running`, `done` and `failed`. `done` and `failed` end a job.
  `progress` runs from 0 to 1. A frame that never settles (no sign of work for a minute) fails its job
  (`--timeout`, [cli.md](cli.md#common-flags)), its error naming t, and the next job runs.

### `POST /render {variant? | variants?, params?, format, t?, revision?}` → `{job}` or `{jobs}`

Renders on your machine, with the CLI's own hosts and ffmpeg, one job at a time in the order
asked. Every field is checked first: a bad one is `400`, and nothing is queued or saved.

- **`variant`** is a name in shaderera.json's `variants`. Leave it out for the film itself. An
  unknown name is `400`. The answer is `{job}`.
- **`variants`** is a list of those names, for several at once, in place of `variant` (not with
  it). Every name is checked first: an unknown one is `400` and nothing is queued. The answer is
  `{jobs}`, one job a name (a name given twice renders once), queued in the order given, each
  with its own `job` events and file. `params`, `format` and `t` apply to every one.
- **`params`** is an object. Its values go over the defaults and the variant's. An undeclared
  name fails the job.
- **`format`** is required, one of:
  - `"mp4"`: H.264, the same file `shaderera render` makes;
  - `"mov"`: ProRes 422 HQ;
  - `"png"`: one still, at `t` seconds (`0` by default). `t` must be inside the film (and inside
    each variant asked), from 0 up to its length: one outside is `400`.
- **`revision`** renders a saved revision instead of the tree, from its frozen copy, on one host.
  Its own variants, params and length apply. An id that is not 16 hex digits is `400`; one the
  project does not keep is `404`.
- **The project is saved as a revision first** (without `revision`), and a video is tagged with
  its revision, as `render` does.
- **Its end is an activity entry** (`render`), done or failed.
- **The file stays in the project**, as
  `out/studio/<project>[-<variant>][-<revision>]-<job>.<mp4|mov|png>`.
  In the variant's name, anything but letters and digits (in any script), `_`, `.` and `-`
  becomes `_` (`16:9` is `16_9`, `tête` stays `tête`).
- **Only the newest export is kept** for each variant and format: when a job is done, the older
  files of that name in `out/studio/` (another job id) are removed. A file you renamed or moved
  out of `out/studio/` is never touched; keep an export by renaming it.

### `GET /render/<job>/file`

The job's file, streamed for the page to save, with:
- `Content-Type`: `video/mp4`, `video/quicktime` or `image/png`;
- `Content-Disposition: attachment; filename="…"; filename*=UTF-8''…`, exposed to the page.
  `filename` is the name in ASCII, with `_` for anything else; `filename*` is the name itself,
  percent-encoded UTF-8 (RFC 6266), for a project named in any script.

A job that is not done gets `409`. An unknown one gets `404`, and so does a done job whose file
was deleted since.

### `POST /render/<job>/cancel` → `{job}`

Cancels a job that is queued or running. It ends as `failed` with the error `cancelled`, and the
next job starts. A queued job never runs; a running one's hosts are closed, every one, a frame that never
settles with them, and a video's partial file is removed, as a failed render leaves it. A job that
has ended gets `409`. An unknown one gets `404`.

### `POST /share {title?}` → `{film, version, url}`

Runs `shaderera share` as you, with your own sign-in (`npx shaderera login`), to `--api`. Pressing
Share in the page is the confirmation. A new film is titled `title`, else as `share` titles it.
`url` is the film's page, as `share` prints it; a poster or loop ffmpeg could not make is a
`warn` log line, and a film that did not render is refused, as `share` refuses it.

- **Not signed in** (no token for `--api`, or it refused the token): `401` with
  `{error:"login", command:"npx shaderera login"}`. The page shows the command to run.
- **Anything else** that stops the share (no licence, a player that does not build, a film that
  does not render, a version over the API's limits, the API unreachable): `500` with `{error}`.

A share's end, sent or not, is an activity entry (`share`). Its steps are not sent.

### `GET /comments[?state=open|fixed|resolved|all]` → `[thread]`

The comments on the film, in the order they were made, `all` by default. Each is the folded
thread, as `shaderera comments --json` gives it:

```json
{
  "id": "k3x9q2", "by": "person", "at": "…", "updated": "…", "state": "open",
  "revision": "…", "t": 1.5, "frame": 45, "to": 2, "toFrame": 60, "variant": "9:16",
  "point": [120, 300], "size": [1080, 1920], "object": "…", "shot": { "id": "…", "offset": 0.5 },
  "params": { … }, "text": "…",
  "replies": [{ "at": "…", "by": "agent", "text": "…", "fixed": true, "revision": "…" }],
  "fixedIn": "…", "stale": false
}
```

- **States** are `open`, `fixed` and `resolved`. A reply with `fixed` makes it `fixed` in that
  reply's `revision` (`fixedIn`). The person's reply to a fixed comment opens it again.
- **A deleted comment** is in no listing (`state` takes `open`, `fixed`, `resolved` or `all`).
  Its `comment` event says `state: "deleted"`, so the page takes its marker away.
- **`stale`** is true when the tree now is not the one the comment was made on.
- Another `state` is `400`.

### `POST /comments {revision, t, to?, variant?, point? | box?, object?, shot?, params?, text}` → thread

The person's comment, at `t` seconds (to `to`). Only the bridge writes comments `by: person`.
That guards against an agent's mistakes, not against a hostile process on your machine: anything
that can write the project can append to `versions/comments.jsonl`.

- **`revision`** is the tree the page shows (`/info`'s, a `changed` event's, or a held one's). The
  working tree's id now is saved as a revision. Any other must be a stored revision, listed or not
  (a tree the page framed is stored, above), and `t`, `variant` and the frame are that revision's.
- `t` (and `to`) must be inside the film or the variant.
- `point` (`[x, y]`) or `box` (`[x, y, w, h]`, w and h above 0), not both, are in that variant's
  frame pixels, inside the frame.
- `object` is an id of at most 200 characters; `shot` is `{id, offset}`; `params` is an object of
  at most 16 KB as JSON, and keeps only those that differ from the defaults.
- `text` is at most 4000 characters.
- A field that is wrong is `400`, and nothing is saved.

### `POST /comments/<id>/reply {text}` → thread

The person's reply. To a `fixed` comment, it opens the comment again. An unknown id is `404`.

### `POST /comments/<id>/state {state}` → thread

`resolved` resolves it; `open` opens it again; `deleted` takes it back. Only the person resolves
or deletes, so only the page does. A deleted comment is for good: a reply or another state for it
is `400`, and `shaderera comments show <id>` still says it was deleted. Another `state` is `400`;
an unknown id is `404`.

### `GET /activity[?limit=200]` → `[entry]`

The project's activity, oldest first: the last `limit` entries (1 to 1000).

```json
{ "id": "…", "at": "…", "by": "cli|agent|studio", "kind": "…", "image": true }
```

| `kind` | By | Fields |
|---|---|---|
| `command` | `cli` | `command`, `args`, `exitCode`, `ok`, `summary` |
| `tool` | `agent` | `tool`, `ok`, `ms`, `summary?` |
| `note` | `agent`, `cli` | `text`, `comment?`: what the agent means to do (`activity add`) |
| `edit` | `studio` | `files: {added, removed, changed}`, at most 50 names each |
| `render` | `studio` | `job`, `ok`, `format`, `variant?`, `revision?`, `file` or `error` |
| `share` | `studio` | `ok`, and `film`, `version`, `url`, or `error` |

- `summary` is `{error, warning, info, messages}`: the findings' counts by severity, and the
  first three messages.
- `image` is there, and true, when the entry has a still: `GET /activity/<id>/image`.
- The activity is this machine's, and lossy: it rotates past 1 MB.

### `GET /activity/<id>/image`

The entry's still, `image/png`. None is `404`.

### `GET /versions` → `{head, log, revisions}`

- `head`: as in `/info`.
- `log`: what was saved, restored and undone, oldest first, as `shaderera versions --json` gives
  it (`{at, action, id, by, label?, pruned?}`).
- `revisions`: every stored revision, oldest first, without its files:
  `{id, parent, created, by, label?, note?, unlisted?}`. `unlisted` is a tree a page framed,
  which no log line names.

### `GET /file?path=<path>`

A file of the project, streamed, for the page to play the film's sound. `path` is as a revision
names it (`audio/score.wav`), and the bridge checks it as a revision does:
- a path outside the project, through a link, or one a revision never holds (`out/`,
  `versions/`, `.shaderera/`, `node_modules/`, …, in any case) is `400`;
- a path that is not the file's own name on disk is `400`: another case (`.ENV` for `.env`), an
  8.3 short name (`ENV~1`), any alias;
- a file that holds secrets (`.env`, `.npmrc`, keys, …) is `400`;
- a missing file is `404`.

`Content-Type` is the file's: `audio/wav`, `audio/mpeg`, `audio/ogg`, `audio/flac`, `audio/mp4`,
`audio/aac`, and the common image and video types. Any other is `application/octet-stream`.

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
- **Each request is answered on its own**, as a direct one is: results come in any order, and a
  long one (a share) holds back no other.
- **Events** go through the relay once the page has sent its first `rpc`.
- **A file comes in chunks.** The Worker takes WebSocket messages of 32 MiB at most, and a film's
  mp4 or mov is often larger. After the head, the CLI sends `chunks` frames `rpc-chunk`, in order,
  each holding up to 512 KiB of the file (a frame stays under 1 MiB). A chunk's box is the bytes
  sealed with AES-GCM under the session key and a fresh iv, with the additional data
  `"<id>:<seq>"`, so a chunk opens only in its own place: the relay can neither reorder chunks nor
  move one to another request. The page joins them in order; their length is `size`. A file that
  cannot be read is `{status:500, body:{error}}` with no chunks. A page that hears no chunk for a
  while gives up on the file.
- **`/runner` is not available through the relay**, with or without `revision`: a frame cannot
  go through it. It answers `400`. The preview needs the direct connection to 127.0.0.1; the page
  says so, and Export (any size, in chunks), Share, the comments and the activity still work.
  Compare through the relay uses two stills (`POST /render {format:"png", revision, t}`).
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
  - `comment` (`kind`: `new|reply|resolve|reopen|delete`): what the person did to a comment;
  - `compare`: a Compare opened;
  - `error`: a code only.
- **What it never sends:** code, file names, params values, frames or titles, nor a comment's
  text, ids, times, revisions or points (ADR 0025 point 10).
- **Turning it off.** Either of these makes `telemetry` false in `cli-hello` and `/info`, and the
  page then sends nothing:
  - `SHADERERA_TELEMETRY=0`;
  - `shaderera telemetry off`.

  The page holds its events until one of those reports `telemetry`.

`shaderera telemetry off|on|status` keeps the choice in `~/.shaderera/config.json`.
`SHADERERA_TELEMETRY=0` turns it off whatever that file says. A config that cannot be read counts
as off, and is never overwritten: fix it or delete it. The first `shaderera studio` prints
a notice saying all of this, once, and notes in the same file that it did.
