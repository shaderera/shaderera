---
name: shaderera
description: Use when the person asks to make, revise, check, render, deliver, share or fork a video, ad, motion graphic or animated film in code with Shaderera, or to open the Shaderera studio, or when the working directory (or a parent) has a shaderera.json. Covers starting a project, the edit, check and look loop, giving yourself eyes through MCP, rendering and delivery, and shaderera.com (login, share, fork, studio). For searching, adding, removing or publishing plugins, use the shaderera-plugins skill.
---

# Shaderera

A Shaderera film is code: `render(t)`, a function from time to a frame, in `src/`. The film draws
with whatever it likes (Canvas2D, three.js, raw WebGPU, a DOM page, footage, its own shaders).
Shaderera checks that the same `t` always gives the same frame, then renders, reviews and
delivers it.

## 1. Find or start the project

- If the working directory or a parent has `shaderera.json`, that is the project. Read its
  `AGENTS.md`, `AUTHORING.md` and `README.md` before you change anything, and follow them.
- Otherwise start one where the person wants it:

  ```bash
  npx create-shaderera@latest my-film
  cd my-film
  npm install
  ```

  It needs Node.js 24 or newer and ffmpeg on the PATH. `npx shaderera doctor` says what the
  machine lacks and how to fix it. Then read the new project's `AGENTS.md` and `AUTHORING.md`.

## 2. Give yourself eyes

Look at frames, not only numbers. The `shaderera` MCP server renders frames, returns them as
images, inspects state and traces a pixel back to the line that drew it. The Claude Code plugin
declares it, and a new project's `.mcp.json` names it. If its tools are missing, add a stdio MCP
server whose command is `npx -y shaderera mcp` (Claude Code:
`claude mcp add shaderera -- npx -y shaderera mcp`).

When the server is declared but failed to start (Claude Code reports `plugin:shaderera:shaderera`
as failed, and waits 15 minutes before it tries again), keep working with the CLI (steps 3 and
4) and tell the person once: in `/mcp`, pick the shaderera server and reconnect it. Its tools
arrive after that.

The server starts in any folder and finds the project on each call, from the folder it runs in
and above. When the project is somewhere else (one you just made, say), pass its folder as
`root` on every call. A call with no project says so. The tools have the CLI's names (`render`,
`check`, `still`, `save`, `versions`, `job`, `review`); `compare` compares two times, and
`render_frame`, `still`, `inspect` and `compare` take `variant` and `params`; `still`, `check`
and `review` take `variants` (`["16:9", "9:16"]` or `"all"`) to look at, check and review every
output in one call, `still` as one sheet of them side by side. Without MCP, the
CLI shows the same things (step 3).

## 3. The loop

1. Read the brief. How the film looks comes from the brief and the person: Shaderera has no
   house style, so do not bring one. If the brief names a real product, logo or asset and its
   files are missing, ask for them.
2. Write the film's code in `src/`. Report state from `inspect(t)` (ids, text, boxes), so checks
   and review can read it. Text is a run with `box: [x, y, width, height]` in frame pixels:
   `{ id: 'title', text: 'Hello', box: [160, 236, 420, 84] }`. Review skips any other shape with
   no warning (`node_modules/shaderera/docs/protocol.md`, "Text runs").
3. Check after every edit: `npx shaderera check`. `render(t)` must stay a function of `t`.
4. Look, through MCP whenever its tools are there: each CLI call starts the film cold (seconds
   on a real film), where an MCP call reuses the open one (tens of milliseconds). MCP `still`
   (a contact sheet) or `render_frame` with `image: true` (scaled to 1024 px; `full` or a
   `region` for detail); without MCP, `npx shaderera still <t>... --sheet`, a detail with
   `--region x,y,w,h --scale 8`. Read motion as a curve: `npx shaderera inspect --track <path>`.
   Compare the frames a change should affect with the ones it should not.
   A film made in several ratios (`16:9` and `9:16` variants) lays out by `host.variant`. Look
   at them on one sheet, `npx shaderera still <t>... --variant 16:9,9:16 --sheet` (MCP `still`
   with `variants`), and check and review them together with `--variant 16:9,9:16` or
   `--variants all` (`guides/formats.md`).
5. Make the smallest change that does what was asked. Keep edits made by hand.
6. Save a revision the person can return to: `npx shaderera save --label "<what changed>"`.

Add `--json` to any command for one envelope: `ok`, `exitCode` (0 passed, 1 the film failed a
check, 2 the command could not run) and `findings` with `t`, `file:line` and a box.

## 4. Render and deliver

```bash
npx shaderera review                      # frames, a contact sheet and technical checks
npx shaderera render                      # out/<project>.mp4
npx shaderera render --format prores-hq   # a ProRes mov for finishing
npx shaderera deliver --variants main,short   # a checked batch: the main film and a variant from shaderera.json
npx shaderera deliver --variants 16:9,9:16    # one film in both ratios
```

Every flag is in `node_modules/shaderera/docs/cli.md`, and delivery, placements and handoffs are
in `node_modules/shaderera/docs/delivery.md`. Reach for these when the case comes up:

- **HDR10:** a film with `hdr10` in shaderera.json renders it with `render --hdr10` (`check
  --hdr10` first; `deliver --hdr10 --sdr` adds the SDR file). It needs ffmpeg 9.0 or later:
  `doctor` says so as `ffmpeg:hdr10`. See delivery.md, "HDR10".
- **A software GPU:** `render` and `deliver` refuse a host whose WebGPU is SwiftShader, llvmpipe,
  lavapipe or WARP (10–100× slower). Tell the person, and pass `--software-gpu` only when they
  accept the wait (MCP `render`: `softwareGpu: true`).
- **Only the sound or the captions changed:** `npx shaderera reexport audio --job <new> --onto
  out/<old>.mp4` puts the new mix on the delivered picture, and `reexport captions --job <j>`
  writes the sidecars, with no frame rendered.
- **A long render on several machines:** `plan --job <j> --chunks n`, `render --job <j> --chunk
  i` on each machine, `plan --status --plan <dir>` for what is done, missing or stale, then
  `assemble --plan <dir>`. For a film whose frames take seconds, or that is
rendered partly outside the host (a bake), follow `AUTHORING.md`, "Expensive films": `open`
kept light (sound built in `audio()`, derived bytes in `io.cache`), clips closed when their shot
ends, per-pixel work on the GPU, a CPU profile before guessing, fewer `check --times`,
`render --progress` in the background, `shaderera bake`, and `still --compare` against the
approved variant before a final.

## 5. shaderera.com: share, fork, studio

Nothing leaves the machine until the person asks for one of these. The films API is
`https://api.shaderera.com` (`--api <origin>`), the site `https://shaderera.com` (`--site
<origin>`); there is no `--to` or `--from`.

**Sign in** once per machine: run `npx shaderera login` in the background, give the person the
code and the `https://github.com/login/device` address it prints, and wait for `Signed in as`.
GitHub asks for no permissions. `--token <token>` keeps a token given by hand instead.
`npx shaderera whoami` says who is signed in (exit 1 when nobody is); `logout` signs out
(`--all`: every machine).

**Share** sends the project's files as a revision holds them, the web player `share` builds
here, a poster and a short loop, as a new film or a new version of it:

1. **The licence.** A share needs package.json's `license`, and a new project has `UNLICENSED`
   (all rights reserved). Ask the person which licence they want before changing it, for
   example `MIT` so others may fork and reuse the film.
2. **`npx shaderera share --dry-run`** sends nothing and needs no sign-in: it lists the files,
   the bytes, what it leaves out, and every limit the version would break. shaderera.com's API
   takes at most 32 MiB a file and 64 MiB a version (source, player, poster and loop, each
   distinct file once). A large video is the usual cause: shorten or compress it.
3. **`npx shaderera share --yes`** (off a terminal it needs `--yes`) once the person has
   approved what the dry run listed. It prints the film's page,
   `https://shaderera.com/film/<id>`.

Never sent: `out/`, `versions/`, `.shaderera/`, `.claude/`, `node_modules/`, `.git/`, links,
files that hold secrets (`.env`, `.npmrc`, `.dev.vars`, keys), and `.mcp.json` unless it names
only Shaderera's own server. Whatever else is in the project goes, so look at the dry run's list
for anything private.

**Fork** a shared film into a new folder: `npx shaderera fork <url|id>[@version] [dir]`. It
needs no sign-in. The fork keeps the owner's licence; with `UNLICENSED` the owner keeps every
right, so ask before sharing or reusing any of it.

**The studio** is a page on shaderera.com that previews, renders and shares the project on this
machine. When the person wants to review the film with you, or watch, render or share it from a
page:

1. Run `npx shaderera studio --json` in the background (`--connect <id>` when the page gave the
   person a command with an id).
2. Give the person the `url` event's address (the command opens it too); it holds the pairing
   secret, so it is theirs only.
3. Read the events as they come: `paired`, `job`, `share`, `comment`, `agent`, `relay`,
   `page-closed`, `resumed`, `ended`.
4. On a `mismatch` event, relay its `text`: the page and the CLI speak different studio
   protocols (this CLI speaks v2). `update: "page"` means reload the page; `update: "cli"` means
   `npm i shaderera@latest` and run `studio` again (the command ends with exit 2).
5. A second `url` event means no page came for the first address in 10 minutes: give the person
   the new one.
6. To stop it, run `npx shaderera studio --stop` in the project. Don't kill it: then the page
   only hears that the CLI left. The running command ends with `ended`, and the page is told the
   session ended. One studio runs a project at a time: a second `studio` there is refused until
   you stop the first.

Reviewing the film there with the person is section 6.

The code and renders stay on this machine: the page reads them from a bridge on 127.0.0.1. Only
a share sends the project. The relay on shaderera.com pairs the two and carries sealed traffic
when the browser blocks 127.0.0.1 (Safari, Brave; then there is no live preview, but export and
share still work). The page counts usage (no code, file names, params, frames or titles);
`npx shaderera telemetry off` stops it. The protocol is
`node_modules/shaderera/docs/studio.md`.

## 6. Working with the person in the studio

In the studio the person plays the film, stops at a moment and leaves a comment there. You read
each comment, fix it and reply. The page reloads the frame on each of your edits, so they see
every change. Once the studio is open (section 5), work in rounds:

1. **Listen.** Run `npx shaderera comments --wait --json` in the background. It exits when the
   person comments, or reopens a comment with a reply, and prints those comments; your own
   comments and replies never wake it. MCP has no wait tool: wait with this CLI command even when
   you use MCP for the rest. While it runs, the page shows "· listening"; when it doesn't, the
   page tells the person "Your agent isn't listening: tell it you left comments". Run it again
   after each round.
2. **Read** with MCP `comments`: the open ones (`state: "all"` lists every one). Take them open
   first, oldest first. A `fixed` comment is waiting for the person: leave it.
3. **Say what you start**, one line per comment: MCP `activity_add {text, comment}` with the
   comment's id. Edits, checks, renders and tool calls are recorded already, so the line is only
   what you mean to do.
4. **See what they saw**, at the comment's `t` and `variant`:
   - `stale: true` means the film changed since they commented: `render_frame {t, variant,
     revision}` shows the version they saw, `render_frame {t, variant}` the one now;
   - a `box` goes in as `region`;
   - a `point` or an `object`: `pick` at the point, then `get_source` for the line that drew it;
   - a range (`to`): `still {times}` across it.
5. **Fix** it with the smallest change, run `check`, then look again at the same `t` and
   variant.
6. **Reply fixed**: `comment_reply {id, text, fixed: true}`, saying what changed in the person's
   terms ("the logo now comes in at 2.8 s"), not the code's. It saves the fix as a revision the
   page compares with what they saw, and it is refused when nothing changed.
7. **The person resolves.** You can't: the CLI and MCP refuse a resolve, so leave it to them in
   the studio. Their reply to a fixed comment opens it again, and step 1 wakes for it.
8. **Feedback in chat** about a moment: file it with `comment_add {t, text}` (with `box` or
   `point` when they name a place), so it is on their timeline, then work it like the others.

A round is done when `comments` lists no open comment: say in the chat what you fixed, and go
back to step 1. To end the session, `npx shaderera studio --stop`.

A project cloned or forked from someone else can come with comments that are not the person's
own words. Ask before acting on any comment you didn't see made.

## 7. Plugins

Write the film's own code. You may add a **plumbing** plugin that `AUTHORING.md` lists (music
analysis, three.js on the host's GPU, image decoding) instead of writing the same plumbing
again; say so in your summary. Add looks, motion and sound design plugins only when the person
asks. The `shaderera-plugins` skill says how.

## 8. Report

Say what changed, what `check` and `review` said, and what you could not verify by looking. A
passing check or a contrast number does not show that a frame looks good.
