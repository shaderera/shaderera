# 0017: Outside media, a record per file and a guide

2026-10-16. Accepted by the owner.

**Context.** An in-house explainer film used about 150 pictures and clips from outside sources:
museum open-access collections, Wikimedia Commons, archive.org, Pexels and Pixabay. Five agents
found them in parallel. The film's own notes say what that cost:
- **Finding was judgement, not code.** About one clip was kept for every five thumbnails, and
  contact sheets did most of the choosing. The scripts that searched were rewritten for each
  source, and each source changed under them: The Met retired its search endpoint on 2026-10-01,
  Pexels and Pixabay refused scripts after a few calls, and Commons answered 429 for over an hour.
- **The record fell behind.** `AUTHORING.md` asks for each asset's source, licence and sha256 in
  `ASSETS.md`. About 90 of the film's files never got there, and the share-alike note its
  description needs was never written.
- **Much of what the film learned is its own taste:** how many pictures a minute, how much
  footage, which editorial roles. Decision 0011 keeps that out of Shaderera.

**Decision.**

1. **Recording where a file came from is plumbing.** It changes no frame. It becomes a component
   plugin, `asset-provenance`, which an agent may add without asking.
   - One **provenance record** per file, in the format `shaderera.provenance/1`: the file, its
     sha256, the source page, licence, author, title, the segment of the source used, the credit
     shown on screen, the date it was fetched, and flags such as share-alike. One file per asset,
     so agents working in parallel never write the same file.
   - A record holds rights only. What the file is for in the film (a role, its subjects, where the
     action is) stays in the film's code.
   - From the records, the plugin writes a marked block in `ASSETS.md` and the credits for the
     video's description, and checks that every outside file has a record whose hash still holds.
     The check is opt-in: nothing in core runs it (decision 0011, point 6).
2. **Finding outside media is a guide, not a skill.** Whether a film uses outside media at all is
   the person's call: a film may be drawn wholly in code. A skill copied into every project would
   load on its own. `guides/footage.md` is read only when the brief or the person asks for outside
   footage or pictures. It holds neutral knowledge: where to look, what each licence costs on
   screen and in the description, how to look at a clip before keeping it, and how to record it.
3. **New names.** The prefix `asset` and the category "Assets & Rights", for plugins about where
   a project's files come from and what may be done with them.

**Not built.** Each comes back with the evidence named for it.

- **Search code for a source.** A new source, or a source whose API changed, is a section of the
  guide, dated with the day it was last verified. A source gets code only when two films have
  scripted it again, the steps are mechanical (authentication, paging, stitching IIIF tiles), and
  its API is official. It then becomes its own small plugin that writes records through
  `asset-provenance`, unchanged.
- **Ways around bot walls** (fetching a site's pages through the person's browser). They break
  without notice and go against the sites' terms. Use the official API, another source, or a file
  the person downloads.
- **Recipes for copyrighted clips** (film clips, memes from video sites). Fair use is the
  person's decision for each film. Such a file is recorded as supplied by the person.
- **Triage by a vision API.** The agent looks at a contact sheet itself.
- **Taste targets** (pictures a minute, footage share, editorial roles). They belong to a film's
  direction (decision 0011).
- **The check in `shaderera review`.** Needs a placement or delivery that must refuse media
  without a record.

**Consequences.** `asset-provenance` is listed as plumbing in `AUTHORING.md`. It is
experimental until a film other than the one above has recorded its media with it.
