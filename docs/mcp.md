# MCP

`shaderera mcp` serves the CLI's operations as MCP tools over stdio, so an agent can render,
inspect, diff and trace a frame back to its code, review it, and save revisions and render jobs.
It starts in any folder, and accepts `--root`, `--trusted` and `--timeout`.

## Add it to your agent

- **Claude Code:** the Shaderera Claude Code plugin (`claude plugin install shaderera@shaderera`,
  see [INSTALL.md](../INSTALL.md)) declares the server, so it runs in every session.
- **A project from `create-shaderera`** has a `.mcp.json` with the server, for agents that read
  one (Claude Code asks once before it starts a project's server).
- **Any other agent:** add a stdio MCP server whose command is `npx -y shaderera mcp`. In Claude
  Code without the plugin: `claude mcp add shaderera -- npx -y shaderera mcp`.

Outside a project, `npx -y shaderera` runs the latest published CLI; inside one, the project's
own install.

## Which project

The server starts anywhere; no tool call needs a project before it is made. Each call finds its
project as the CLI does: from its `root` (every tool takes one; relative to the server's folder),
or else from the server's folder (`--root`, or the folder it was started in), then each folder
above it, up to the first `shaderera.json`. A call that finds none is an error that says to pass
`root` or start a project with `npx create-shaderera@latest`. So one server serves a project made
after it started, and several projects, each with its own child.

For each project the server keeps one child process open and reopens it (rebuilding the entry) on the next call
after any file under the root changes, except in `node_modules`, `.shaderera` and `out`. So an
edit is picked up without restarting the server. `shaderera.json` is read again with it, so a new
size or fps reaches every tool.

Tool calls run one at a time, whole: a `render_frame` with a `camera` never reaches a frame that
another call renders. The project's own console output goes to the server's stderr, so stdout
carries only MCP.

## Tools

Every tool returns one JSON text block, except `render_frame` and `review`. Every tool also
takes `root?` (see [Which project](#which-project)). Errors come back as `isError` with
the message.

| Tool | Input | Output |
|---|---|---|
| `render_frame` | `t`; `final?` (default true; `false` renders `preview`); `camera?` `{view, projection}`; `image?`; `region?` `[x, y, w, h]` or `object?` (an id with a `bbox`), `scale?` 1–16 | `{ sha256, meanRgba, alphaBox, layers, ms }`; a PNG block only with `image: true`, of the region when one is given |
| `inspect` | `t`; `path?` | the inspect JSON at `t`, or the value at `path` |
| `diff` | `a`, `b`; `path?` | `{ changes, pixels }`: `diffJson` of the two inspects (under `path`) and `diffPixels` of the two final frames |
| `pick` | `t`, `x`, `y` | `{ pick, object, source }`: the `Pick`, the inspected object with that `id`, its `source` |
| `get_camera` | `t` | `{ matrices, description, path, source }`; `description` is eye, forward, up, fovY, aspect, near, far |
| `get_source` | `id`; `t?` (default 0) | `{ path, file, line, column, around }`; `around` is ±8 numbered lines. Only a file inside the project (symbolic links followed) is read |
| `check_determinism` | `times?` (default 20), `seed?` | like `shaderera check`: `{ times, failures, what, msPerFrame, previewVsFinal }` |
| `export` | `from?`, `to?`, `out?`, `job?` | `{ out, frames, seconds }` (needs ffmpeg). `out` must be inside the project. With `job` (a name from `create_job`), renders that frozen job instead of the working tree. A source that is not deterministic is refused and no file is left ([determinism.md](determinism.md#export-refuses-a-source-that-fails)) |
| `save_revision` | `label?`, `note?` | the revision, saved in `versions/`; the same files always have the same id |
| `list_versions` | — | `{ head, log, jobs }`: the head revision, the log of saves, restores and undos, and the render jobs |
| `create_job` | `variant?`, `params?`, `revision?`, `name?`, `label?`, `from?`, `to?` | the job. Freezes a revision (the project is saved first unless `revision` is given), a variant from `shaderera.json`, params over the defaults and an optional window, like `shaderera job` ([cli.md](cli.md#versions-and-jobs)). It never replaces a job |
| `review` | `variant?`, `quick?` | like `shaderera review` ([cli.md](cli.md#review)): the report JSON as text, then the contact sheet and each principal frame's thumb (shots and the last frame; not the transition samples) as PNG images. Files go to `out/review/` (a variant: `out/review/<variant>/`); requirements from `requirements.json` |

Notes from the code:

- `render_frame`'s `camera` is applied with `camera.override` for that one frame, then released.
- `alphaBox` is the bounding box of pixels with alpha > 0, or `null`.
- `get_camera` takes `source` from the inspect object whose `id` is `camera` or whose path ends in
  `camera`. That is the literal of your camera object, which may be a computed one.
- `pick` on a source without `pick` returns `{ "pick": null, "object": null, "source": null }`.
- Images are opt-in on purpose: hashes, means and boxes are cheaper to read and compare.

## Walk-through: a camera jump

A film interpolates a camera between keys, and one key is wrong. Ask the agent to find a jump.

**1. Scan `get_camera`** over t in frame steps. Eyes at two neighbouring frames:

```json
// get_camera { "t": 4.1 }
"description": { "eye": [3.7699553966522217, 1.600000023841858, 1.3369508981704712], "fovY": 43.99999881007018, ... },
"path": "camera", "source": "src/composition.ts:37:10"

// get_camera { "t": 4.133 }
"description": { "eye": [4.153251647949219, 1.600000023841858, 1.428560495376587], "fovY": 43.97045428586254, ... }
```

The eye moves 0.394 m in one frame (1/30 s), where neighbouring frames move a few centimetres.

**2. `diff`** the two times under `camera`:

```json
// diff { "a": 4.1, "b": 4.133, "path": "camera" }
{"changes":[
  {"path":"eye[0]","a":3.76995520772679,"b":4.1532517708868415},
  {"path":"eye[2]","a":1.3369509084980105,"b":1.428560405492499},
  {"path":"fov","a":44,"b":43.970454545454544},
  {"path":"between[0]","a":"k4","b":"k5"},
  {"path":"between[1]","a":"k5","b":"k6"}],
 "pixels":{"pixels":518400,"differing":45112,"max":239,"mean":2.6062827932098767,...}}
```

`get_camera`'s `source` points at the computed camera (`cameraAt`'s literal, line 37). The diff
says which keys it is between: the jump happens while passing `k5`.

**3. `get_source`** for that key:

```json
// get_source { "id": "k5" }
{"path":"keys.5","file":"...\\src\\composition.ts","line":20,"column":3,
 "around":"...\n19:   { id: 'k4', t: 4.1, eye: orbit(1.23), target: [0, 0.5, 0], fov: 44 },\n20:   { id: 'k5', t: 4.12, eye: orbit(1.236, 4.4), target: [0, 0.5, 0], fov: 44 },\n21:   { id: 'k6', t: 5, eye: orbit(1.5), target: [0, 0.5, 0], fov: 42 },\n..."}
```

`k5` is at `src/composition.ts:20:3`: 0.02 s after `k4`, on a 4.4 m orbit instead of 4 m.

**4. Fix and verify.** The agent edits the file **with its own tools** (Edit, Write). Shaderera's
MCP has no tool that edits project code: the server notices the change, and the next `get_camera`
scan, `diff` and `check_determinism` run against the new code.
