# 0002: WebGPU in Node is the project's dependency

**Observed problem.** A source that uses WebGPU (three's `WebGPURenderer`, raw WebGPU) gets
`host.gpu` in the browser but had nothing in the Node host, so `check`, `render` and MCP could not
run it.

**Measurement.** `webgpu@0.6.2` (Dawn for Node) is about 137 MB unpacked. With it, a three.js
product film renders 1280x720 in Node at about 16 ms per frame (`check --times 20`) on
an RTX 5070 Ti through D3D12.

**Existing solution considered.** The `webgpu` npm package already provides a standard
`GPUDevice` in Node; nothing needs writing. Making `shaderera` depend on it would put 137 MB on
every install, including the many projects that only use Canvas2D.

**Smallest change.** The Node host resolves `webgpu` from the project root with
`createRequire`. If the project installed it, the host creates one adapter and device, assigns
Dawn's globals (`GPUBufferUsage` and friends) and passes the device as `host.gpu`; otherwise
`gpu` stays undefined, as the protocol allows. The child's `--allow-fs-read` already covers the
project's dependencies (and the pnpm store they live in), and `--allow-addons` lets Dawn's native
addon load. The host keeps a reference to Dawn's GPU object: dropping it lets the GC destroy the
instance under a live device and crashes readback.

**LOC impact.** About 20 lines in `apps/cli/src/node/host.ts`.

**Public API impact.** None: `Host.gpu` already exists. A project that wants WebGPU in Node adds
`webgpu` to its own devDependencies.

**How to reverse.** Delete `gpuDevice` from `host.ts`; sources fall back to whatever they do
without `host.gpu`.
