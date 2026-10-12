# 0012: Delivery and agent tooling for professionals

2026-10-12. The owner delegated these decisions, after approving the first part of a core
research report.

**Context.** [0011](0011-experts-and-agents-no-taste-lock.md) settled what core may hold: data,
ports, raw GPU resources and measurements, never a look; and it judges only what a person
declares. The core research report then named what professionals still could not get out of
Shaderera:
- a file an agency, a CTV network or Reels accepts;
- sound and picture in sync in every player;
- precision past 8 bits;
- a way for an agent to read motion and results without parsing prose.

Three questions were left open for the owner: edit lists, the adapter's power preference, and
which of the next items to build.

**Decisions.**

1. **Edit lists stay the default; `--no-edit-list` is the opt-in.** Sync decides it. With no edit
   list, a player that ignores edit lists sees the same file as one that honours them: the video
   gets negative composition offsets, and the mix loses the AAC priming. Measured with a beep at
   0.500 s: 500.56 ms in both kinds of player, with x264 and with NVENC. The default file, in a
   player that ignores edit lists, puts the picture 66.7 ms late and the beep 21.3 ms late.
   - The price of `--no-edit-list` is the first 21.3 ms of the mix. A hit on frame 0 would lose
     its attack, so it is not the default.
   - A placement that forbids edit lists says so (`editList: false`), and `deliver` fails the
     file until it is rendered with `--no-edit-list`.
2. **The adapter's power preference is not set.** Changing it could move pixels on machines with
   two GPUs. The host identity records the adapter, `webgpu`'s version and the feature count
   instead, in `delivery.json`.
3. **Built:**
   - ProRes 422 HQ and 4444 with alpha.
   - 16-bit frames from the GPU compositor, for ProRes and 16-bit PNGs.
   - `--bitrate` and `--maxrate`.
   - Stems, by `AudioClip.group`.
   - `Source.captions()`, written as SRT and WebVTT sidecars and never drawn into the frame.
   - Placements, where core owns the schema and the check, and the numbers are catalog data
     with their sources.
   - `doctor`.
   - One `--json` envelope, and exit code 2 for a run that could not happen.
   - Declared `timing` and `inspect --track`.
   - Close looks with `still --region` and `--object`, and in MCP.
   - Wall-clock reads counted, and a second Dawn refused as it loads.
4. **Built later the same day,** when the owner asked for the rest without waiting for jobs, and
   answered four questions first:
   - `fps` may be written as 23.976 or `"24000/1001"`; both mean the exact fraction,
     whole rates change nothing, and timecode is drop-frame at 29.97 and 59.94.
   - `plan`, `render --chunk` and `assemble`, with no infrastructure assumed. Chunks
     assembled give the same bytes as one render (mp4 and ProRes).
   - `preroll`, `timecode` and `textless` per variant; a plain slate in the catalog.
   - `io.image`, `io.video`, `io.cache` and `AudioClip.pcm`, the same bytes in both
     hosts; glyph outlines and Gaussian splats as catalog items.
5. **Not built:**
   - A software adapter for golden pixels on CI: the owner chose not to build it yet.
   - **HDR** (PQ/HLG, scene-linear compositing): the owner chose to wait for a customer who
     needs it.
   - A vgpu host stays a catalog item to write when a film uses vgpu. It would take `host.gpu`
     through `initFromDevice`, as `render-three-host` does for three.js, because a second Dawn is now
     refused.

**Measured on 2026-10-12** (Windows 11, NVIDIA Blackwell, ffmpeg 8.1.1, `webgpu` 0.6.2):
- **Banding.** A float layer ramping red 0.4 to 0.6 over 256 px. The widest flat band was:
  - 12 px in H.264;
  - 6 px in ProRes HQ from 8-bit frames;
  - 4 px in ProRes HQ from 16-bit frames;
  - 3 px in ProRes 4444.
- **Bitrate.** `--bitrate 2M` on a still 256×64 frame gave 1.91 Mb/s with x264 and 1.81 with NVENC.
  crf gave 0.2.
- **Stems.** The stems sum to the mix within 1e-5.

**What it does not do.**
- Nothing here changes a frame: the codecs, rates, sidecars and checks act on the file.
- There is still no HDR and no scene-linear compositing.
- No placement, timing or loudness target is assumed. Each is checked only where a person
  declared it.

**How to reverse.** Each item is its own commit and its own flag or field. Removing one leaves the
rest working.
