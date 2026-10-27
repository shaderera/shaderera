# 0030: Footage frames reach the host through shared memory, not through the CLI's thread

2026-10-28. Proposed (#498), waiting for the owner's approval; #499 implements it. Amends 0007
(parallel export) and 0027 (where the decoder's frames go). The owner decided (2026-10-27) that
Shaderera always takes the fastest way the machine can render, and allowed hardware decode
everywhere.

**Context.** `io.video` waits far longer than decoding takes. One ffmpeg decodes a 1080p H.264
frame in about 6.5 ms on one thread, yet a Node host waits 34 ms a frame on `io.video` with one
host and 63–98 ms with four. Four hosts render footage slower per host, and the GPU is 5–26 % busy.

A frame's bytes in the Node host today, at `10a8afb`:
1. ffmpeg's stdout (a pipe) → the clip's decoder thread in the CLI (`decoder.ts`), copied into
   the frame's buffer as the chunks come. Decoding, swscale's RGBA conversion and the pipe cost
   ffmpeg about 8 ms a frame on its own.
2. The decoder thread copies the kept frame again, so the asker owns its bytes (`read`, "a copy
   of its own").
3. That copy moves to the CLI's main thread (`postMessage`, transferred, no copy). This thread
   serves every host's requests, every clip, and the hosts' rendered frames.
4. The CLI's main thread announces the frame on IPC and writes it to the host's bulk pipe
   (`child.ts`, `bulk.ts`): a copy into the pipe.
5. The host's main thread takes the pipe's 64 KB chunks (about 130 a frame) and copies them into
   one buffer (`bulkReader`).
6. The film uploads it (`writeTexture`, a copy into Dawn's staging).

The browser host shares 1–3. Then the runner server answers an HTTP request with the bytes
(`runner-plugin.ts`), and the worker reads them with `Response.arrayBuffer()`
(`runner/worker.ts`). The web player decodes its H.264 proxy with WebCodecs in the browser
(`player/media.ts`), so it has none of this.

**Measured** (2026-10-28, RTX 5070 Ti, i5-14400F with 16 threads, Windows 11, ffmpeg 9.0.2).
- **The films.**
  - *fetch*: two 300-frame 1080p H.264 clips. Each `render(t)` asks for frame `t × 30` of both
    and uploads them. It does no other work.
  - *particles*: a copy of the team's showcase-particles film, with two 1080p clips, many frames
    of them held.
- **How.** `render --no-audio`, one run at a time. `videoMs` is the render's last line, "waiting
  on io.video", a frame. The hops were timed in the built CLI with throwaway code.
- **The load.** The machine was otherwise idle (CPU 2–7 %). It was 75–84 % busy during each
  four-host render. Another session held the GPU at 59 % during one run (particles, ring, four
  hosts).

Where one RGBA frame's wait goes today, on *fetch* (mean ms a fetch, one host / four hosts):

| hop | 1 host | 4 hosts |
|---|---|---|
| waiting for the decoder, with copy 2 | 9.1 | 27.0 |
| copy 2 alone | 2.9 | 5.4 |
| decoder thread → CLI thread | 1.6 | 4.9 |
| CLI thread writes the pipe (sync) | 1.6 | 2.8 |
| … until the host has read it all | 12.3 | 28.9 |
| host: IPC answer → bytes assembled | 9.1 | 20.2 |
| **the host's whole wait** | **24.9** | **68.8** |

- **The pipe.** Moving the bytes through the CLI's thread and the bulk pipe costs more than
  decoding them. The pipe holds 64 KB, so it moves only while both busy threads read and write
  it.
- **The seeks.** About a third of the wait is not the hop at all. It is the first frame of each
  clip and the frames `render` re-checks out of order (0007, #447): each re-check is a seek, a
  decode from the keyframe before it. They are 4.7 s of 14.9 s with one host and 15 s of 42 s
  with four. Short-GOP footage (#450) is what speeds those up.

The options, prototyped (`videoMs` a frame; four hosts' wall time for the whole render in
brackets):

| option | *fetch* RGBA, 1 / 4 hosts | *fetch* `yuv420p` (0027), 1 / 4 | *particles*, 1 / 4 | bytes |
|---|---|---|---|---|
| today | 27.5 / 76.7 (10.8 s) | 16.3 / 47.3 (7.4 s) | 33.3 / 63.2 (7.3 s) | — |
| (a) ring file, slot written when asked | 21.4 / 60.7 (9.1 s) | 13.2 / 46.7 (7.1 s) | | equal |
| (a) same, read through `UV_FS_O_FILEMAP` | 26.5 / 83.0 (10.8 s) | | | equal |
| (a) ring, each frame written as decoded, host reads without waiting | 18.2 / 69.0 (10.1 s) | 10.6 / 47.7 (7.5 s) | 15.0 / 27.7 (5.8 s) | equal |
| (a) + frame threads, decoding twice as far ahead | — / 54.4 (9.5 s) | — / 22.8 (6.7 s) | | equal |
| (b) the decoder in each host | 10.4 / 62.3 (26.3 s) | 9.3 / 45.9 (19.3 s) | 18.7 / 39.0 (17.8 s) | equal |
| (c) NVDEC (`-hwaccel cuda`) in the CLI | 31.2 / 87.8 (12.1 s) | 18.3 / 51.0 (8.2 s) | | equal¹ |
| (c) NVDEC in each host | 11.9 / 67.0 (27.1 s) | | | equal¹ |
| a held frame kept in the host | | | 22.1 / 36.1 (6.8 s) | equal |
| browser host, today | 71.3 / 138.5 (20.7 s) | | | — |

- **Bytes.** "Equal" means the md5 of every frame `io.video` returned (600 a render) matched
  today's. That was checked with four hosts for (a), (b), the threaded decoder, and NVDEC with
  `yuv420p`.
- **¹ NVDEC.** It gives the same Y'CbCr samples as software, here and on #498's two clips, but as
  NV12. swscale's NV12→RGBA path rounds differently from its yuv420p→RGBA path, so the RGBA
  md5 differed. A `format=yuv420p` shuffle before the conversion (lossless) made it equal.
- **Load.** Today's rows were run twice and agreed within 5 %; the others ran once. Rows a few
  ms apart are within the noise of a busy machine.

What the rows say:
- **(b) is fastest for one host, and decodes everything N times for N hosts.** Hosts take
  interleaved frames (0007), and H.264 cannot skip the frames between, so each host's ffmpeg
  decodes every frame. Four hosts then took 2.4× longer than today.
  It also needs `--allow-child-process` and `--allow-worker` in the host, the process that runs
  the project's code (`child.ts`, `permissionArgs`), so the project could start any program.
- **(c) gains nothing here.** The RGBA path is bound by swscale's conversion, not by decoding.
  Each restart (a seek, a re-check) pays about 150–200 ms to start CUDA. ffmpeg runs in another
  process, and `webgpu` 0.6.2 has no import of outside GPU memory. So NVDEC can hand the host
  only system memory, never a texture.
- **(a) gains most when the frame is already in the ring when the host asks**, which takes
  decoding ahead (the frame threads and the larger window).
- **A file on disk is not shared memory.** The ring as a file in `.shaderera/` wrote 0.36–2.8 GB
  to disk during a 10-second render, against 77 MB without it, whatever its open flags
  (`FILE_ATTRIBUTE_TEMPORARY` wrote more). Node has no anonymous shared memory between
  processes.

**Decision.**

1. **One decoder a clip, in the CLI's process, as today.** N hosts still share one decode of each
   frame (0007, 0028). (b) is rejected (above).

2. **The decoder writes each frame into a ring of slots in shared memory, and the Node host reads
   it there.**
   - **The ring.** The clip's decoder thread makes an anonymous shared memory section: a pagefile
     section on Windows, `shm_open` on macOS and Linux. It is never a file in the project or on
     disk.
   - **The slots.** The ring holds `slots` frames of the clip's format (RGBA or `yuv420p`).
     - Each slot starts with a stamp, the index of the frame it holds.
     - Frame `i` goes in slot `i mod slots`.
     - `slots` is the frames the decoder keeps plus the frames it decodes ahead, plus one.
   - **Writing.** ffmpeg's stdout chunks are copied straight into the frame's slot as they come.
     That is the only copy before the host, and it replaces copy 2. The stamp is set to −1
     while the slot is written and to `i` after (a seqlock).
   - **Reading.** The host maps the section read-only. It sends its request as today, so the
     decoder knows how far the hosts are.
     - If the slot's stamp is already `i`, the host copies the slot into the film's own bytes and
       checks the stamp again. It does not wait for the answer.
     - Otherwise it waits for the answer, which says the frame is in its slot.
     - A stamp that changed during the copy means the slot was reused. The host then asks again
       and waits.
   - **What leaves the path.** The CLI's main thread carries no frame bytes, and the bulk pipe
     carries only the rendered frames.
   - **What a film gets.** `Footage.frame(i)` still resolves to bytes of the film's own (the
     `Io` contract does not change), copied once from the ring. `videoTexture` (0027) may upload
     the planes from the mapped slot without that copy. Copy 2 dropped is what the prototype
     measured; this upload is an addition it did not.

3. **The mapping is a small native module of the CLI.** Node cannot share memory between
   processes on its own.
   - **What it does.** Create, open read-only and close a named section, exposed as an
     `ArrayBuffer`. Nothing else.
   - **How it ships.** Prebuilt N-API binaries for Windows x64, Linux x64 and arm64, and macOS
     arm64 and x64, like `@napi-rs/canvas`. A person needs no compiler.
   - **The sandbox.** The host may already load addons (`--allow-addons`, for `webgpu` and the
     canvas). It gets no new permission.

4. **The decoder decodes further ahead, on frame threads.**
   - **Threads.** It runs `-threads 4` from frame 0 too, not only after a seek. ffmpeg's frame
     threads give the same bytes (`decoder.ts` already relies on this for seeks), and the md5
     check above confirmed it.
   - **The window.** It decodes up to `2 × hosts + 1` frames past the latest asked. The window
     is bounded by the ring's size, not by `AHEAD_BYTES`.
   - **The ring's size.** It defaults to 64 MiB a clip, or the window's frames if they need more:
     about 200 MB for four hosts at 1080p RGBA, and 75 MB in `yuv420p`.

5. **Hardware decode is allowed, but it is not the default yet.** The rule for later:
   - **When.** It becomes the default on a machine where it measures faster. That should be
     long-GOP HEVC or 4K footage, where decoding rather than the conversion bounds the frame.
     Nothing here measured that.
   - **The bytes.** Its NV12 is shuffled to `yuv420p` before swscale, which keeps them equal.
   - **The test.** It is tested by the same md5 comparison against software decoding.
   - **No texture.** It never hands the host a GPU texture (above).

6. **`render(t)` does not change.** The bytes are equal to today's, frame by frame, in both
   formats. The ring changes how bytes travel, never which bytes they are.

**Without the fast path.**
- **No section.** The native module may have no binary for the platform, or the section may fail
  to be created (a container without `/dev/shm`, say). Then the clip goes over the bulk pipe as
  today, with the same bytes, and `doctor` names the reason.
  - (Should the owner prefer it, no native module at all. Linux could use a file in `/dev/shm`,
    which is memory, and Windows and macOS would keep the pipe. The decision would then reach
    only Linux, the rented GPU machines of 0022.)
- **The browser host** keeps the runner server's HTTP path: Chrome cannot map a section. It
  gains only point 4. Its `io.video` (71 / 139 ms above) is its own issue: a page reads footage
  for a DOM film.
- **The web player** is unchanged: it decodes its proxy with WebCodecs in the viewer's browser.

**The test that proves the bytes.** `io.video` returns the same bytes over the ring as over the
bulk pipe. An `*.it.ts` test renders the repo's footage fixture with one and with four hosts,
both ways, in `rgba` and `yuv420p`, and compares the md5 of every frame. The film covers:
- a held frame;
- a jump back;
- a jump far ahead (a seek);
- a slot reused while a host reads it, forced with a ring of `keep + ahead + 1` slots and a slow
  reader, which must ask again and never return a torn frame.

A fast test covers the seqlock and the slot arithmetic. The hardware path, when it lands, adds
the same comparison against software decoding.

**Expected `videoMs`.**
- **How it is measured.** The render's last line, at 1080p, on *particles* and *fetch*, one run
  at a time on an idle machine, before and after (#499 puts the numbers in its PR).
- **The particles film:** about 15 ms with one host and 28 ms with four, from 33 and 63. Its
  four-host render about 20 % faster.
- **The fetch film in `yuv420p`:** about 11 ms with one host and 23 ms with four, from 16 and 47.
  Its four-host render about 10 % faster.
- **The fetch film in RGBA:** about 18 ms with one host and 54 ms with four, from 28 and 77.
  Four ffmpeg-RGBA clips cannot be decoded and converted ahead of four hosts on one thread
  each (swscale converts on one).
- **Why these are upper bounds.** The prototype used a file, whose reads went through the page
  cache at 1.8 GB/s (4.6 ms for 8.3 MB). A mapped section is a memory copy, so the real ring
  should match or beat them.
- **What remains.** Most of what is left with four hosts is the first frames and the re-check
  seeks (#450), and a CPU 75–84 % busy, not the hop.

**Rejected.**
- **(b) The decoder in each host.** N decodes for N hosts, slower overall, and it needs the
  sandbox loosened (above).
- **Contiguous spans of frames per host**, so that each host's own decoder decodes only its span.
  Simulated with four CLIs on four quarters of *fetch*, each host decoding its own quarter, it
  took 10.0 s (11.8 s with today's transport), with four encoders on a saturated CPU. One render
  on four hosts takes 10.8 s today. It needs the plan and `assemble` machinery for every local
  render.
- **A ring as a file.** It writes gigabytes to disk (above), and mapped file reads in libuv
  (`UV_FS_O_FILEMAP`) were slower than plain reads.
- **Hosts as worker threads of the CLI**, which could share a `SharedArrayBuffer`. They would lose
  the permission sandbox, which is per process.
- **Converting RGBA in the host from `yuv420p` sent over the pipe.** The RGBA bytes must stay
  swscale's, whose rounding (and SIMD paths) a port would have to match.
- **(c) as the default now**, for the reasons above.
- **Keeping the last frame in the host.** It was measured above: 33 → 22 ms on *particles*. The
  ring holds a held frame anyway, as long as it is in the window, so this adds nothing.

**Not measured here.**
- A real mapped section. The file-backed ring stood in for it.
- macOS and Linux.
- 4K, ProRes and long-GOP HEVC footage.
- NVDEC on HEVC 10-bit.
- The browser host with point 4.

**How to reverse.** The ring sits behind the same request and answer. Turning it off leaves
today's bulk pipe, which stays as the fallback, so reversing it changes no bytes.
