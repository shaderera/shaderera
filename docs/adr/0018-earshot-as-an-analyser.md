# 0018: Earshot as an analyser, and a plugin before a film

2026-10-17. Decided by the owner.

**Context.** [Earshot](https://github.com/Leonxlnx/earshot) (MIT, 0.2.0) gives coding agents
ears. Two open models on the CPU (CLAP for text against sound, an AudioSet tagger) and a set of
measurements say what a sound is, how well it fits a description, and where the best takes are
inside a long recording. It also makes sound effects in code (`forge`), fits a recording as code
(`fit`), scores a film against seven launch films (`critique`), and carries a skill that sources,
mixes and masters licensed recordings (`real-sound`). It runs as a CLI, a Python API and an MCP
server; its first use downloads about 1.4 GB of models.

An agent making a Shaderera film cannot hear. It picks and trims sound effects blind, and a
sound whose loudest moment sits 300 ms into its file (a whoosh) lands late on every hit.

Decision 0016 says a plugin is code a film proved, and one film proves the need, not the shape.
No Shaderera film has used Earshot yet.

**Decision.**

1. **Earshot is an analyser** (the glossary's word): the person's own install, run apart from
   rendering. Shaderera never installs, vendors or requires it, and core runs none of it.
2. **One plugin now, before a film:** `audio-listen`, plumbing. It turns Earshot's `find` into
   **trims** of a recording, stamped with the recording's sha256 (`shaderera.analysis/1`, kind
   `sound-trims`), adds each take's peak measured with ffmpeg, and places a trim so its peak
   lands on a **hit point**. It reads either Earshot's CLI or an answer the agent saved from
   Earshot's MCP server, which keeps the models loaded between calls.
   - The owner chose to build it before a film. Its shape comes from Earshot's own documented
     contract (`find`'s segments), not from a film's code, so it is experimental until a film
     has chosen its takes with it.
3. **What stays out of Shaderera:**
   - **`critique` and its launch profile.** It is a taste target (0011 point 6, 0017): seven
     launch films' loudness arc would fail a film whose silent open or hard silence is the point.
   - **`real-sound`'s mixer and design JSON.** A source's `audio()`, with gain functions and
     `group` stems, is the mixer, written as code. Finding recordings is the person's call and
     the footage guide's kind of knowledge; their rights go in `asset-provenance` records.
   - **`measure`.** `render` already measures loudness (EBU R128) and `--loudness` moves the mix.
   - **`realness` and the Gemini critique.** The first is easy to please (Earshot says so); the
     second uploads the person's audio.
4. **A sound forged outside the host is a plain project file**: the WAV, with forge's
   `report.json` beside it, saved in revisions like any file. Bakes stay frames only.

**Not built.** Each comes back with the evidence named for it.

- **Forge recipes in TypeScript**, rendered in `audio()` from the seed so each hit is a new take.
  Needs a film where the same sound repeats often enough (forty key presses) that trims from one
  recording and forge's few variants audibly repeat. Each recipe's character is taste: it would be
  added only when asked.
- **A sync tolerance in requirements.json.** Needs a placement or a person that declares one.
  Until then an offset between a hit point and its sound is reported, never failed (0011).
- **Provenance for a derived file** (an `earshot fit` of a licensed recording). Needs a film that
  ships one.
- **Earshot's tags in `review-av-timeline`.** Earshot itself calls tags inside a busy mix hints;
  needs a review where onsets and the spectrogram were not enough.
- **An audio bake.** Needs a forged sound that went stale against its recipe in real work.

**Consequences.** `audio-listen` is listed as plumbing in `AUTHORING.md`. Its preview and an end
to end run need an Earshot install, which is the person's own.
