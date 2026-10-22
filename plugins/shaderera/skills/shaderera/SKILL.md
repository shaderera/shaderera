---
name: shaderera
description: Use when the person asks to make, revise, check, render or deliver a video, ad, motion graphic or animated film in code with Shaderera, or when the working directory (or a parent) has a shaderera.json. Covers starting a project, the edit, check and look loop, giving yourself eyes through MCP, and rendering and delivery. For searching, adding, removing or publishing plugins, use the shaderera-plugins skill.
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
4. Look: `npx shaderera still <t>... --sheet`, a detail with `--region x,y,w,h --scale 8`, or
   MCP `still` (a contact sheet) or `render_frame` with `image: true` (scaled to 1024 px; `full`
   or a `region` for detail). Read motion as a curve: `npx shaderera inspect --track <path>`.
   Compare the frames a change should affect with the ones it should not.
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
```

Every flag is in `node_modules/shaderera/docs/cli.md`, and delivery, placements and handoffs are
in `node_modules/shaderera/docs/delivery.md`. For a film whose frames take seconds, or that is
rendered partly outside the host (a bake), follow `AUTHORING.md`, "Expensive films": `open`
kept light (sound built in `audio()`, derived bytes in `io.cache`), clips closed when their shot
ends, per-pixel work on the GPU, a CPU profile before guessing, fewer `check --times`,
`render --progress` in the background, `shaderera bake`, and `still --compare` against the
approved variant before a final.

## 5. Plugins

Write the film's own code. You may add a **plumbing** plugin that `AUTHORING.md` lists (music
analysis, three.js on the host's GPU, image decoding) instead of writing the same plumbing
again; say so in your summary. Add looks, motion and sound design plugins only when the person
asks. The `shaderera-plugins` skill says how.

## 6. Report

Say what changed, what `check` and `review` said, and what you could not verify by looking. A
passing check or a contrast number does not show that a frame looks good.
