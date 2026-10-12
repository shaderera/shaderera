# 0011: Experts and their agents, and no taste lock

2026-10-12. Owner accepted.

**Context.** Six in-house films were made on the development build in two days, among them the
opening film. Each film kept a log of what the engine lacked (`ENGINE-GAPS.md`, `REGISTRY-GAPS.md`). Reading
those logs against the films' code showed four things:
- **No gap was a hard ceiling.** Every one was worked around inside the project. What the films
  paid for was friction and time.
- **The catalog's plumbing was reused as it was.** Four films carry `review-stills` byte for
  byte, and one used `audio-beat-clock`. Another copied an older analyser from the opening film
  instead, because nothing told it the item existed.
- **Each film wrote its own looks, and that is right.** One film's halftone, another's ASCII and
  a third's bloom are each film's taste, not duplicated work.
- **The beginner path pulled against the rest.** It meant treatments, a template category and
  look presets made to be used as they come. All three steer a film toward a default look.

The owner restated the product's premise: a very skilled creator must be able to make any video at
all, and nothing in Shaderera may cap or lock their taste. Beginners already get their prompts from
experts, so designing for them adds work and confusion.

**Decision.**

1. **Who Shaderera is for:** expert creators, and the agents working for them. There is no
   beginner path. A beginner is served by an agent prompted well, and an agent needs exactly what
   an expert needs: clear errors, reference docs, and tools that look at frames.
2. **No taste lock.** Core and the shared libraries give data, ports, tools and raw GPU access,
   and never a look.
   - Nothing hides `GPUDevice`, buffers or shaders behind a wrapper.
   - Nothing ships a default that decides how a frame looks.
   - The test is the one 0008 uses for metadata: **if it decides how a frame looks, it is not
     core and not a shared library.** Looks stay in the film's own code, or in catalog items a
     person asks for and then owns.
3. **Treatments are removed.**
   - `create-shaderera` makes an empty project that is set up correctly: `shaderera.json`, a
     `render(t)` that draws nothing yet, the agent notes, the reference docs and the skill.
   - `shaderera treatments` and `shaderera treatment use` are gone. The local agent writes the
     film's code itself.
4. **No starter films.** Nothing a project starts from is a finished film. (The examples that
   were kept as engine tests were removed at 0.1.0; the tests use small fixtures.)
5. **Decision 0008 amended.** The `template` item type and its categories are retired. The types
   are now extension, component, preset and media.
6. **Measure everything; judge only what is declared** (added 2026-10-12, owner's audit).
   - Review and delivery report what they measure on every film.
   - They fail a film on an error: a frame that differs between orders, a readback that does not
     hold, a missing glyph, an asset that failed to load.
   - They fail a film on a craft rule only when the person declared it in requirements.json: an
     end hold (`endHold`), a reading time (`readingTime`), a text overlap limit (`textOverlap`), no
     blank frames (`noBlankFrames`), a safe area (`safeArea`).
   - Without a declaration such a check reports as `info`. There is no default safe area, end hold
     or reading time: those were a beginner's guard rails, and they failed films whose fast cuts,
     overlapping type or hard endings were the point.
   - The same holds for anything added later: a placement's spec, a loudness target or a timing
     assertion is checked only where a person declared it.
7. **Every project knows what is on the shelf** (amends the opt-in rule of 2026-10-11).
   - A project's `AGENTS.md` lists the official items, split into two groups.
   - **Plumbing** items carry no taste (stills, music analysis, three.js on the host GPU, image
     decoding). An agent may add one instead of rewriting the same plumbing, and says so in its
     summary.
   - **Looks and motion** items are added only when the person asks.
   - Agents still never search the registry or suggest items on their own.

**Work accepted with it.**
- `shaderera still`, stills at chosen times and a contact sheet, with the same GPU-error
  guard as `check`. It replaces copying `review-stills` into every project.
- A WGSL error is reported as the compiler's own message, file and line, not as the
  cascade it causes.
- The reference docs ship inside the `shaderera` package, the guides are rewritten as
  reference, and the tested `webgpu` version is named.
- `audio-beat-clock` fits its tempo to the onsets, and reads timed text (LRC, SRT, word JSON).

**Accepted later the same day, from a core research report:**
- Review measures everything and judges only what is declared (point 6). The default
  safe area is gone, and `format-safe-areas` `'reels'` follows Meta's spec.
- Both hosts ask the adapter for every feature and its maximum limits (`fullDevice`). On one
  machine a Node device went from 1 feature to 22, and from 128 MB to 2 GB per storage
  binding.
- `AudioClip.gain` may be a function of t, sampled by the host and multiplied in at 48 kHz.
- Loudness (EBU R128) is measured on every output with audio. `--loudness=<LUFS>` applies
  one constant gain, with no compression.
- The mp4's AAC is 48 kHz stereo, and `--no-audio` is added. Edit lists stay the default;
  [0012](0012-delivery-and-agent-tooling.md) adds `--no-edit-list`, which keeps sync in every player.
- The CLI's `agent`, `create` and `revise`, which ran a local agent behind a broker, are removed.

**Waiting for evidence, not rejected.** These waited for a real job; the owner asked for them
anyway on 2026-10-12, and [0012](0012-delivery-and-agent-tooling.md) records what was built:
images and footage decoded the same in every host, a cache for derived data, audio made in code,
glyph outlines and extrusion, and a GPU splat component. HDR still waits.

**Consequences.**
- New projects start empty.
- An agent that needs a reference reads the shipped docs, not a starter film.
