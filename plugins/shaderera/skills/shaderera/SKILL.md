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
`root` on every call. A call with no project says so. The tools have the CLI's names, and
`node_modules/shaderera/docs/mcp.md` lists them. Without MCP, the CLI shows the same things.

## 3. The loop

1. Read the brief. How the film looks comes from the brief and the person: Shaderera has no
   house style, so do not bring one. If the brief names a real product, logo or asset and its
   files are missing, ask for them.
2. Write the film's code in `src/`. Report state from `inspect(t)` (ids, text as runs, boxes), so
   checks and review can read it (`AUTHORING.md`, "Make it editable").
3. Check after every edit: `npx shaderera check`. `render(t)` must stay a function of `t`. On
   ✗: `npx shaderera still --diff <t>` at the t it names, then
   `node_modules/shaderera/docs/determinism.md`, "What breaks it". A `clock` warning means
   `render` read `Date`, `performance.now` or `requestAnimationFrame`.
4. Look, through MCP whenever its tools are there: each CLI call starts the film cold (seconds
   on a real film), where an MCP call reuses the open one (tens of milliseconds). MCP `still`
   (a contact sheet) or `render_frame` with `image: true` (scaled to 1024 px; `full` or a
   `region` for detail); without MCP, `npx shaderera still <t>... --sheet`, a detail with
   `--region x,y,w,h --scale 8`. Read motion as a curve: `npx shaderera inspect --track <path>`.
   Compare the frames a change should affect with the ones it should not. A film in several
   ratios: `guides/formats.md`.
5. Make the smallest change that does what was asked. Keep edits made by hand.
6. Save a revision the person can return to: `npx shaderera save --label "<what changed>"`.

**Open the studio once the first draft passes `check`** and has something to watch, without
being asked: start it (`studio.md`, beside this skill) and give the person its address. From
then on, tell them what changed and at which times to look in the studio, not with a contact
sheet they did not ask for. If they say no, don't open or offer it again this session.

Add `--json` to any command for one envelope: `ok`, `exitCode` (0 passed, 1 the film failed a
check, 2 the command could not run) and `findings` with `t`, `file:line` and a box.

## 4. Render and deliver

While you iterate, look (step 3) instead of rendering. Rendering only the shot that changed, the
time left, drafts and why a render is slow: `guides/review.md`. A whole-film or draft render: the
CLI in the background, not MCP `render`, which blocks, sends no progress and takes no variant,
params or draft. `--workers`: `node_modules/shaderera/docs/cli.md`, `render`.

To patch a window of a film already rendered, never splice files with ffmpeg by hand. A plain
`render` keeps no chunks to reuse: render the film again. A film rendered as a job's plan (`job`,
`plan`, `render --chunk`, `assemble`) is patched with `render --job <new> --reuse <old plan>
--changed <from>-<to>`, then `assemble`: delivery.md, "Re-rendering only what an edit changed".

```bash
npx shaderera review                      # frames, a contact sheet and technical checks
npx shaderera render --draft              # out/<project>-draft.mp4 (guides/review.md)
npx shaderera render                      # out/<project>.mp4
npx shaderera render --format prores-hq   # a ProRes mov for finishing
npx shaderera deliver --variants main,short   # a checked batch: the main film and a variant from shaderera.json
npx shaderera deliver --variants 16:9,9:16    # one film in both ratios
```

Every flag is in `node_modules/shaderera/docs/cli.md`, and delivery, placements and handoffs are
in `node_modules/shaderera/docs/delivery.md`. Reach for these when the case comes up:

- **HDR10:** delivery.md, "HDR10".
- **A software GPU:** `render` and `deliver` refuse a host whose WebGPU is SwiftShader, llvmpipe,
  lavapipe or WARP (10–100× slower). Tell the person, and pass `--software-gpu` only when they
  accept the wait (MCP `render`: `softwareGpu: true`).
- **Only the sound or the captions changed:** `npx shaderera reexport audio --job <new> --onto
  out/<old>.mp4` puts the new mix on the delivered picture, and `reexport captions --job <j>`
  writes the sidecars, with no frame rendered.
- **After a delivery:** run `npx shaderera prune --dry-run` and tell the person what it would
  free and what `out/` holds. Never delete `out/`, `versions/` or jobs without asking.
- **A long render on several machines:** `plan --job <j> --chunks n`, `render --job <j> --chunk
  i` on each machine, `plan --status --plan <dir>` for what is done, missing or stale, then
  `assemble --plan <dir>`.
- **Expensive films** (frames that take seconds, a bake): `guides/speed.md`.

## 5. shaderera.com and the studio

Sign-in, share, fork, the studio and the person's comments there are in `studio.md`, beside this
skill. Read it when the person asks for any of them, and before you open the studio.

## 6. Plugins

Write the film's own code; which plugins you may add is in `AUTHORING.md`, "Plugins". The
`shaderera-plugins` skill says how.

## 7. Report

Say what changed, what `check` and `review` said, and what you could not verify by looking. A
passing check or a contrast number does not show that a frame looks good. With the studio open,
point to the times to watch there instead of a contact sheet.
