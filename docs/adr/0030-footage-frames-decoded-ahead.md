# 0030: Footage frames reach the host faster, in two steps: decoding ahead now, shared memory only if needed

2026-10-31. Accepted (#498, proposed 2026-10-28). The CTO decided on PR #511 that the decision is staged: step 1 now,
which #499 implements, and step 2 deferred. Amends 0007 (parallel export). The owner decided
(2026-10-27) that Shaderera always takes the fastest way the machine can render, and allowed
hardware decode everywhere.

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
| step 1: frame threads, decoding twice as far ahead, over the pipe | 28.0 / 74.5 (11.2 s) | 15.5 / 44.8 (7.1 s) | 26.5 / 55.4 (6.9 s) | equal |
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
  ms apart are within the noise of a busy machine. Step 1's row was measured later the same
  night beside a rerun of today (29.0 / 76.4, 15.5 / 51.1, 31.9 / 61.1).

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

**Decision, step 1 (decided; #499 implements it).** The CLI's decoder decodes on several
threads and further ahead. The pipe stays the only path.
- **Threads.** The decoder runs ffmpeg with `-threads 4` from frame 0 too, not only after a
  seek. ffmpeg's frame threads give the same bytes (`decoder.ts` already relies on this for
  seeks), and the md5 check above confirmed it with four hosts.
- **The window.** It decodes up to `2 × hosts + 1` frames past the latest asked, and its byte
  cap (`AHEAD_BYTES`, 64 MiB) doubles with it. That is about 133 MiB a clip for four hosts at
  1080p RGBA, and in `yuv420p` the window, not the cap, sets it.
- **Unchanged.** One decoder a clip in the CLI's process (0007, 0028). The bulk pipe to the
  Node host, the runner server for the browser host, and the web player's WebCodecs all stay as
  they are. There is no native module and no new dependency.
- **`render(t)`.** The bytes are equal to today's, frame by frame, in both formats.
- **The pipe.** The trace supports no cheap win that needs no dependency. The hop's time is the
  pipe's flow, not its copies:
  - The writes take 1.6 / 2.8 ms, and the host's reassembly copy of 8.3 MB about 2 ms.
  - Waiting until the host has read everything takes 12.3 / 28.9 ms. The pipe holds 64 KB,
    libuv's fixed buffer for a Windows named pipe, so it moves only while both busy threads
    service it.
  - So "fewer, larger chunks" is not Node's to choose on Windows, and dropping the reassembly
    copy would save about 2 of 69 ms.
  - #499 may still try reading straight into the frame's buffer (`net.Socket`'s `onread`). It
    keeps that only if the measurement shows a gain and the bytes stay equal.

**Expected `videoMs` of step 1, and how #499 measures it.**
- **What it was measured as.** Step 1's own row above, on its own, without the ring:

  | film | 1 host | 4 hosts |
  |---|---|---|
  | *particles* | 32 → 26.5 | 61 → 55 |
  | *fetch*, RGBA | 29 → 28 | 76 → 74.5 |
  | *fetch*, `yuv420p` | 15.5 → 15.5 | 51 → 45 |

  The four-host wall time barely moves.
- **What that means.** Step 1 alone is small, at 0–12 %. The rest of the wait is the pipe hop
  and the seeks (#450).
- **How #499 measures it.**
  - *particles* and both *fetch* films, at 1080p, with 1 and 4 hosts, in RGBA and in `yuv420p`.
  - One run at a time, on a machine otherwise idle, before and after.
  - `videoMs` is the render's last line ("waiting on io.video").
  - It reports the pipe hop's share at four hosts: the CLI's write plus the host's wait from the
    IPC answer to the assembled bytes, timed as in the trace above.
- **The bytes.** An `*.it.ts` test renders the repo's footage fixture with one and four hosts, in
  `rgba` and `yuv420p`, decoding on one thread and on four. It compares the md5 of every frame
  `io.video` returns, including a held frame, a jump back and a jump far ahead (a seek).

**Step 2 (deferred, not decided): a ring in shared memory.**
- **When to take it.** Only if, after step 1, the pipe hop is still more than about a third of
  `videoMs` with four hosts. Today it is more than that: from the IPC answer to the bytes alone,
  20 of 69 ms. Step 1 does not touch it.
- **The owner's approval.** It needs a prebuilt native module, which needs the owner's own
  approval at that time.
- **The ring.** The clip's decoder thread makes an anonymous shared memory section: a pagefile
  section on Windows, `shm_open` on macOS and Linux. It is never a file on disk: the file-backed
  stand-in wrote gigabytes (above).
- **The slots.** The ring holds `keep + ahead + 1` frame slots. Each slot starts with a stamp,
  and frame `i` goes in slot `i mod slots`.
- **Writing.** ffmpeg's chunks are copied straight into the slot. The stamp is −1 while the slot
  is written and `i` after (a seqlock).
- **Reading.** The Node host maps the section read-only and still sends its request, so the
  decoder knows how far the hosts are.
  - If the stamp is `i`, it copies the slot into the film's own bytes, checks the stamp again,
    and does not wait for the answer.
  - Otherwise, or if the stamp changed during the copy, it waits for the answer.
- **The module.** A small N-API module of the CLI that creates, opens read-only and closes a
  named section. Prebuilt for Windows x64, Linux x64 and arm64, and macOS arm64 and x64, like
  `@napi-rs/canvas`. The host may already load addons, so it gets no new permission.
- **Fallback.** The bulk pipe, with the same bytes, when the module or the section is not
  available. `doctor` names why.
  - Without a module, Linux alone could use a file in `/dev/shm`, which is memory.
- **What its prototype measured.** With the stand-in, *particles* went from 33 / 63 to 15 / 28
  ms, and *fetch* `yuv420p` with step 1 from 16 / 47 to 11 / 23. A mapped section reads at
  memory speed, so these are upper bounds.
- **Its test.** The bytes over the ring equal the bytes over the pipe. The test also forces a
  slot reused during a read, which must ask again and never return a torn frame.

**Hardware decode: allowed, not the default.**
- **When.** It becomes the default on a machine where it measures faster: long-GOP HEVC or 4K
  footage, where decoding rather than the conversion bounds the frame. That is not measured here.
- **The bytes.** Its NV12 is shuffled to `yuv420p` before swscale, which keeps them equal, and
  the same md5 comparison against software decoding tests it.
- **No texture.** It never hands the host a GPU texture: ffmpeg runs in another process, and
  `webgpu` 0.6.2 imports no outside GPU memory.

**The browser host and the web player.**
- **The browser host** keeps the runner server's HTTP path, and gains only step 1. Its
  `io.video` (71 / 139 ms above) is its own issue: a page reads footage for a DOM film.
- **The web player** is unchanged: it decodes its proxy with WebCodecs in the viewer's browser.

**Rejected.**
- **(b) The decoder in each host.** Hosts take interleaved frames, so each decodes every frame:
  four hosts took 26 s against 11 s. It also needs `--allow-child-process` and `--allow-worker`
  in the host, the process that runs the project's code.
- **(c) NVDEC as the default now.**
  - It gained nothing here.
  - Each seek and re-check pays 150–200 ms to start CUDA.
  - It hands the host system memory only.
- **Contiguous spans of frames per host**, so that each host's own decoder decodes only its span.
  Simulated with four CLIs on four quarters of *fetch*, each host decoding its own quarter, it
  took 10.0 s (11.8 s with today's transport), with four encoders on a saturated CPU. One render
  on four hosts takes 10.8 s today. It needs the plan and `assemble` machinery for every local
  render.
- **A ring as a file.** It writes gigabytes to disk, and libuv's mapped file reads
  (`UV_FS_O_FILEMAP`) were slower than plain reads.
- **Hosts as worker threads of the CLI**, which could share a `SharedArrayBuffer`. They would lose
  the permission sandbox, which is per process.
- **Converting RGBA in the host from `yuv420p` sent over the pipe.** The RGBA bytes must stay
  swscale's, whose rounding (and SIMD paths) a port would have to match.
- **Keeping the last frame in the host.** It took *particles* from 33 to 22 ms. A ring (step 2)
  would hold a held frame anyway. Step 1's decoder already keeps it, so what is left of this is
  the pipe hop, and only step 2 removes that.

**Not measured here.**
- A real mapped section. The file-backed ring stood in for it.
- macOS and Linux.
- 4K, ProRes and long-GOP HEVC footage.
- NVDEC on HEVC 10-bit.
- The browser host with step 1.
- The pipe hop's share after step 1. #499 measures it, and it decides step 2.

**How to reverse.** Step 1 is two numbers in the decoder, the threads and the window. Setting
them back changes no bytes.
