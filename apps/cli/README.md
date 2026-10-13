# shaderera

The Shaderera CLI, hosts and MCP server for films made in code. A film is `render(t)` from
`@shaderera/core`, drawn with any renderer; this package checks that the same `t` gives the same
frame, renders, reviews and delivers it, in Node or in Chrome.

```bash
npx shaderera check                   # the same t gives the same state and pixels
npx shaderera render                  # export (needs ffmpeg on PATH)
npx shaderera review                  # stills, safe areas and checks for a person to look at
npx shaderera deliver                 # every format the project declares
npx shaderera inspect --time 4.13     # the state at t
npx shaderera mcp                     # the same operations as MCP tools over stdio
```

Project code runs behind an execution boundary (Node's permission model in Node, a separate origin
in Chrome), not a sandbox for hostile code. WebGPU in Node comes from the project's own `webgpu`
package. Every command refuses a project whose `shaderera.item.json` requires a package add-on
that is not installed, and names the two ways out (`shaderera add` or `shaderera remove`). Add-ons
are searched, added and published with `shaderera search`, `info`, `add`, `remove` and `publish`
(`docs/add-ons.md`).

Licence: [MIT](LICENSE). Source and docs: https://github.com/shaderera/shaderera
