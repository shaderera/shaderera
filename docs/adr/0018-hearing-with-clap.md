# 0018: Hearing with CLAP, and a plugin before a film

2026-10-17. Decided by the owner.

**Context.** An agent making a Shaderera film cannot hear. It picks and trims sound effects
blind, and a sound whose loudest moment sits 300 ms into its file (a whoosh) lands late on every
hit.

[Earshot](https://github.com/Leonxlnx/earshot) (MIT, 0.2.0, one maintainer) was studied as the
answer. It is Python around two open models, CLAP (`laion/larger_clap_general`, text against
sound) and an AudioSet tagger, with about 1.4 GB of downloads. Its `find` gives the best takes in
a recording for a description. It also makes sound effects in code (`forge`), scores a film
against seven launch films (`critique`), and carries a skill that sources, mixes and masters
licensed recordings (`real-sound`).

The well-used part is the model, not the wrapper. LAION's CLAP is the reference model for text
against sound, and transformers.js runs it in Node on the CPU from ONNX weights.

Decision 0016 says a plugin is code a film proved, and one film proves the need, not the shape.
No Shaderera film has used either.

**Decision.**

1. **CLAP is the analyser**, run by transformers.js in the tool's Node process: no Python, no
   account, nothing sent anywhere. The model is the person's own download (about 780 MB, into
   `~/.shaderera/models` on first use), pinned to one revision and recorded with its licence in
   each artifact. Core runs none of it.
2. **One plugin now, before a film:** `audio-listen`, plumbing.
   - It finds takes (one per onset, or plain windows for beds) and scores each against the
     description.
   - It writes them as **trims**, stamped with the recording's sha256 (`shaderera.analysis/1`,
     kind `sound-trims`), each with its peak measured with ffmpeg.
   - It places a trim so its peak lands on a **hit point**.
   - It is experimental until a film has chosen its takes with it, because the owner chose to
     build it first.
3. **A score is a rank, not a verdict.** A take is compared with the description and with about
   45 everyday descriptions plus any the agent names; rank 1 means none fits it better. Earshot
   calibrated z-scores into words (strong, weak) on its own sound library. A rank needs no
   calibration we have not done.
4. **Earshot is not a dependency.** Its onset-based takes, its ranking against a vocabulary and its
   page of honest limits shaped this plugin. What stays out of Shaderera:
   - **`critique` and its launch profile.** It is a taste target (0011 point 6, 0017): seven
     launch films' loudness arc would fail a film whose silent open or hard silence is the point.
   - **`real-sound`'s mixer and design JSON.** A source's `audio()`, with gain functions and
     `group` stems, is the mixer, written as code.
   - **`measure`.** `render` already measures loudness (EBU R128) and `--loudness` moves the mix.
   - **Its real-or-synthesized guess and the Gemini critique.** The first is easy to please (its
     author says so); the second uploads the person's audio.
5. **A sound forged outside the host is a plain project file**: the WAV, with whatever describes
   how it was made beside it, saved in revisions like any file. Bakes stay frames only.

**Not built.** Each comes back with the evidence named for it.

- **Meta's PE-A-Frame**, which marks where a described sound occurs every 40 ms. Needs a film
  whose recordings hold many overlapping sounds that one-per-onset takes cannot separate; it
  needs Python and PyTorch.
- **Sound effects made in code**, rendered in `audio()` from the seed so each hit is a new take.
  Needs a film where trims from one recording audibly repeat (forty key presses). Each sound's
  character is taste: it would be added only when asked.
- **A sync tolerance in requirements.json.** Needs a placement or a person that declares one.
  Until then an offset between a hit point and its sound is reported, never failed (0011).
- **Tags inside a mix in `review-av-timeline`.** Needs a review where onsets and the spectrogram
  were not enough.

**Consequences.** `audio-listen` is listed as plumbing in `AUTHORING.md` and requires
`@huggingface/transformers`, which brings `onnxruntime-node` (about 300 MB) into the project that
adds it.
