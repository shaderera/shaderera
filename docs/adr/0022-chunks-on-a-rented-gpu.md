# 0022: A plan's chunks on a rented GPU machine

2026-10-22. Proposed, for the owner to approve before any code (#294).

**Context.** A long film at 4K renders for hours on one machine. A plan's chunks already render
anywhere and assemble into the file one render makes (`plan`, `render --job --chunk`, `assemble`,
`--reuse`; [0012](0012-delivery-and-agent-tooling.md)), but only on machines the person has.
Serverless platforms have no GPU. Cloudflare, where the team hosts, rents none either: Containers
offer CPU instance types up to 4 vCPU (changelogs 2025-10-01, 2026-01-05).

webgl2video (github.com/Avi130805/webgl2video at d8ec4fc, docs/findings.md and docs/runpod.md)
renders WebGL films on rented RunPod GPUs:
- A 10-minute 4K60 film cost $0.53 on one RTX 4000 Ada at $0.29/h (about $0.25 for a clean run).
- The render was CPU-bound: an RTX 4090 was 31% busy. Choose a machine by CPU and price.
- The CPU quota is a lottery. Two RTX 4090s listed at 8+ vCPU had 6.8 and 13 cores. It reads
  `/sys/fs/cgroup/cpu.max` and rejects a machine below 75% of its listing before copying anything.
- 2,000-frame jobs left a 20-minute idle tail; 500-frame jobs fixed it.
- Without the driver's graphics libraries the browser silently falls back to software.
- A create call that times out may still make a machine.

Shaderera renders with WebGPU (Dawn in the Node host, Chrome in the browser host), so these
lessons change:
- Y'CbCr is already made on the GPU ([0007](0007-gpu-first-host.md)). The CPU still pays for
  readback, IPC and the FFV1 encode of each chunk, so it still sets the speed.
- Chunks (FFV1) and masters (x264) are encoded on the CPU. NVENC's 8-session cap on GeForce, and
  its absence on A100/H100/B200, do not matter.
- Dawn on Linux uses Vulkan: `libvulkan1`, `NVIDIA_DRIVER_CAPABILITIES` with `graphics`
  (docs/delivery.md). An adapter named lavapipe, llvmpipe or SwiftShader is software.
- `webgpu` 0.6.2 ships every platform's `dawn.node` in one package, so the job's package check
  should hash the same files on Linux. This is not tried yet.

Providers, read 2026-10-22:
- **RunPod** bills pods by the second (docs.runpod.io/pods/pricing).
  - Its API (`POST rest.runpod.io/v1/pods`) takes `minVCPUPerGPU`, `env` and `networkVolumeId`.
    It has no time-to-live.
  - Each pod gets a "Pod-scoped API key", `RUNPOD_API_KEY` (docs.runpod.io/pods/references/environment-variables).
    webgl2video's pods delete themselves with it.
  - A network volume outlives pods at $0.07/GB/month, in one data centre, for Secure Cloud pods
    only (docs.runpod.io/storage/network-volumes).
- **Vast.ai** bills by the second, and stopped storage too (docs.vast.ai/instances/pricing).
- **Lambda** bills by the minute (docs.lambda.ai/public-cloud/billing).
- **Modal** bills by the second, but through its SDK with no SSH (modal.com/pricing).
- **Fly.io** ended its GPUs on 2026-07-31 (fly.io/docs/gpus).

**Decision.**

1. **Core, not a plugin.** Rendering chunks on a rented machine is production work, like export
   and delivery ([0008](0008-core-extensions-and-catalog.md)). It reads plans, handoffs and chunk
   records only core writes, spends money and holds an account key, so it is reviewed engine
   code. It is one CLI command, `shaderera rent`, and decides nothing about a frame (0011).
   _Rejected:_
   - a component, which puts an account key and spending in a project's code;
   - a package plugin, since projects import plugins and the CLI loads none;
   - a second CLI, which 0014 removed.
2. **A provider seam, RunPod first.**
   - **The seam.** A provider lists offers (GPU, $/h, vCPU), rents by a unique name, finds by that
     name, and deletes and confirms. It has volumes where it can.
   - Past the seam the machine is an SSH target running one pinned image (Ubuntu, Node, a named
     ffmpeg, Vulkan). It gets the job as a handoff, runs `npm ci`, then
     `render --job --chunk` and `assemble`.
   - `--on ssh://user@host` is the person's own machine: nothing is rented, so nothing is deleted.
   - **Why RunPod:** per-second billing, a minimum vCPU in the create call, a pod-scoped key so the
     machine can delete itself, network volumes for resume, and webgl2video's measurements.
   _Rejected:_
   - Vast.ai first: unknown marketplace hosts receive the code. It is a later candidate.
   - Lambda first: per-minute billing, and few cheap single GPUs.
   - Modal: a second seam.
   - Fly.io and Cloudflare: no GPUs.
   - No seam: it leaves the person's own machines out.
3. **Money and safety.**
   - **No budget, no machine.** `--go` needs `--budget`. The time cap is the budget over the $/h
     the create call returned. After the first chunk the CLI projects the cost. Over budget, it
     stops and keeps the work.
   - **The machine is always deleted:**
     - by the CLI on every exit it controls;
     - by a watchdog started first on the machine, which outlives the CLI and deletes the machine
       at the cap with the pod-scoped key;
     - by the machine itself when the job ends;
     - by a ledger in `~/.shaderera/`, written before each create: every `rent` deletes machines
       past their cap, finds by name any machine a timed-out create made, and lists volumes left.

     A volume is deleted once its delivery is home and its hash matches.
   - **Credentials stay with the person.** The key comes from `RUNPOD_API_KEY` or a file in
     `~/.shaderera/` that only they can read. It never goes in the project, a plan, a record,
     `delivery.json`, a log or the machine. `rent` sends no telemetry.
   - **A dry run is the default.** Without `--go` nothing is spent. It prints:
     - the account (never the key), the GPU types with live $/h and vCPU, and the chunks;
     - what is sent (handoff, pinned bakes, size), and that the code goes to the provider;
     - the volume's cost a day, the time cap the budget buys, how deletion works, and what
       comes back.

     On arrival, a CPU quota below 75% of the listing or a software adapter deletes the machine
     before anything is copied.
4. **Correctness.**
   - **Byte-identical to local is not promised.** Another GPU, driver or backend (Vulkan, D3D12,
     Metal) may round differently. Exact pixels are promised only within one kind of host, and
     `assemble` refuses mixed hosts.
   - So one kind of rented machine renders every chunk and assembles them, and only the delivery
     comes back. A 10-minute 4K60 film is 36,000 frames of 12.4 MB, so even at 4:1 its FFV1
     chunks are about 110 GB (estimated).
   - **Checked instead:**
     - every existing check, on the machine: packages, bakes, each chunk's determinism re-check,
       and one host identity per plan;
     - the identity also records the driver;
     - a few frames rendered both locally and remotely, with the difference reported, not judged
       (0011). A large one shows a missing font or asset.
   - **Resume.** Chunks go to the network volume, and each record is copied home as it lands.
     Running `rent --plan <dir> --go` again rents the same GPU and image in the volume's data
     centre.
     - It refuses another host identity, and offers the whole plan on the new kind, with its cost.
     - It renders the first and last frame of one finished chunk and compares them byte for
       byte, as `--reuse` samples do.
     - Then it renders only the missing chunks.

     Chunks of about 500 frames keep a loss small. Only on-demand machines are used, never spot.
   _Rejected:_
   - mixing local and remote chunks by default, since a seam may show (`--mixed-hosts` stays);
   - assembling at home, since the chunks are too large;
   - resuming from a stopped pod's own disk, since its GPU may be taken and a lost machine
     loses it.

**Not now.** The browser host remotely: Chrome on Linux needs Vulkan flags it is not given, so
its jobs are refused until measured. A second rented provider, when RunPod has no machine. `rent`
from the studio.

**Consequences.** The CLI gains `rent`, its ledger, and the RunPod and SSH providers. A pinned
image is published with each `shaderera`. The glossary gains **rented machine** (_avoid_: host,
pod, worker). The first build measures what this expects: local against remote frames, two
machines of one kind giving the same bytes, and the package check on Linux.

**How to reverse.** `rent` sits beside `plan`, `render --chunk` and `assemble` and changes none of
them. Removing it leaves them working.
