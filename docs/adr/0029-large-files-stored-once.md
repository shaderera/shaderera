# 0029: Large files stored once: frozen copies by clone or read-only link, footage still stored whole

2026-10-27. Proposed (#476). The owner approved an ADR on the growth investigation. Amends 0003
(revisions and frozen copies). #474 lands first and keeps one unused frozen copy instead of three.
The maintainer decided its open questions the same day (owner: "decide as you recommend"):
read-only hard links on NTFS and ext4 are accepted with the risk in 3; objects become read-only on
every system; a handoff keeps copying as today; references are reconsidered at about twice the
media size (Rejected); macOS clones are checked on a Mac when this is implemented.

**Context.** A project's footage is held by the working tree, by `versions/objects/` and by every
frozen copy (`.shaderera/revisions/<id>/`). The growth investigation (2026-10-27) ran a project
with 247 MB of footage through ten saves, one re-trim, renders, a review, four jobs, a PNG job and
a plan. It ended at 1.45 GB:

| step | total | where it went |
|---|---|---|
| new project | 247 MB | the footage |
| first save | 495 MB | `versions/objects/` +247 MB |
| ten edits, ten saves | 495 MB | nothing: objects are by content |
| re-trim the footage, save | 687 MB | a new 196 MB object |
| renders, review, stills | 693 MB | `out/` a few MB |
| each new job's render (×3) | +244 MB each | a new frozen copy |
| at the end | 1.45 GB | working 247, objects 444, frozen 731, `out/` 28 |

The code at `78c5050`:
- **`store`** (`revisions.ts` ~357) copies each new file into `versions/objects/<sha256>` while
  hashing it. A changed file, however small the change, is a whole new object.
- **`checkout`** (~412) writes each file of a revision by copying its object. `materialize`
  (~504) uses it to build a frozen copy, so every frozen copy is a byte copy of the whole revision.
- **`KEEP_FROZEN = 3`** (~609): three unused frozen copies stay after a render.
- **`prune`** removes revisions nobody names, the objects only they held, and unused frozen copies.

With 2 GB of footage and a few re-trims, the same steps give 15–25 GB. #474 cuts the frozen
copies from three to one. What is left: a frozen copy costs the whole revision again, and the
footage is stored twice (working tree and object).

**Decision.**

1. **One way to place a stored file, tried in this order: clone, then read-only link, then copy.**
   - **Clone** (`copyFileSync` with `COPYFILE_FICLONE_FORCE`): a copy-on-write copy that shares
     the blocks until one side is written. APFS (macOS), btrfs and XFS (Linux), and ReFS / Dev
     Drive (Windows 11) have it. Writing to a clone never changes the other file.
   - **Read-only hard link** (`linkSync`), when cloning fails: ext4, and NTFS on Windows. The
     object is made read-only (`0o444`; the read-only attribute on Windows) before it is linked,
     and the frozen copy's file is the same file as the object.
   - **Copy**, when both fail: exFAT and FAT drives, network shares, or anything else. That is
     today's behaviour.
2. **Where each one may be used.**
   - **A frozen copy** (`materialize`): clone, link or copy. Nothing in the project edits a frozen
     copy: a job only builds and reads it.
   - **A save** (`store`) and **a restore or undo** (`checkout` into the working tree): clone or
     copy, **never a link**. The person edits the working tree in place, and a link would carry
     that edit into the stored object.
   - **A handoff** (`writeHandoff`) is unchanged: it copies, and never links to the project's own
     objects. It leaves the machine, so saving its space is not worth a second rule.
3. **The guarantee stays: an edit never renders under a revision's id.**
   - **With a clone** nothing changes. An edit to the copy stays in the copy. The check on every
     use (`checkout` hashes the frozen copy against the revision) finds it, and the file is
     placed again from the object.
   - **With a link, writing in place is refused**: the file is read-only on every system. This was
     tried on NTFS: writing or appending through the link fails with `EPERM`, and removing the
     link leaves the object read-only.
   - **An editor that saves by writing a new file and renaming it over** the frozen file breaks
     the link. The object is untouched; the check finds the copy differs and links it again.
   - **A tool that clears read-only and writes in place** changes the object too. The check hashes
     the frozen copy before every use, as it does today, and `readObject` and `checkout` hash the
     object. So it is found as `versions/objects/<hash> is corrupt` and the render is refused.
     Never silent, and never rendered under the id. The cost: that object is lost for every
     revision that holds it, unless the working tree still has the file. Only deliberate tools
     do this, so it is accepted.
   - **No new check.** The check today hashes the whole frozen copy on each use, and stays as it
     is.
4. **Footage stays stored whole, inside the project.**
   - **No content store shared by projects, and no external references.** A re-trim is a new
     file, so it is a new object. `prune` removes the trims no named revision holds. The skill
     says to trim once (#474).
   - **Projects stay self-contained**: a revision holds every byte it renders. So nothing changes
     for share, fork, handoff or `render --job` elsewhere:
     - share uploads by sha256 what the site lacks;
     - fork writes files;
     - a handoff carries its objects;
     - a job renders from its revision.
5. **`prune` counts the bytes it frees.** A linked or cloned file frees nothing until its last
   link goes, so `prune`'s byte count counts a file only when `nlink` is 1, and counts no clones.
   It may then undercount clones' shared blocks, since nothing in Node reports those.

**What it gives.** After #474 and this ADR the investigation's project would end at about
715 MB on NTFS instead of 1.45 GB: working tree 247, objects 444, frozen copy about 0, `out/` 28.
After a `prune` that drops the first trim it would be about 520 MB. With 2 GB of footage that is
about 4 GB on NTFS and ext4 (the working file and its object), plus each trim a named revision
keeps. On APFS, btrfs, XFS and ReFS a save clones too, so it is about 2 GB. Not 15–25 GB.

**Considered and rejected.**
- **Read-only links for saves too** (object = the working file). Every edit to footage in place
  would then rewrite the stored revision. A save would also have to make the person's own files
  read-only.
- **A content store shared by the person's projects** (`~/.shaderera/objects`).
  - It saves bytes only across projects and forks on one machine, and a clone gives most of that
    already.
  - It does nothing for a re-trim, which is the growth that is left.
  - `prune` in one project cannot know which objects another project names, so it would need a
    store-wide collector and registry of projects.
  - Copying a project folder would no longer copy its history.
- **External references by sha256 and size** (footage stays outside the project, and a revision
  names it).
  - It gives the most: no object at all for footage.
  - But a revision no longer holds what it renders. Share must still find and upload the bytes.
    Fork gets a name for a file it does not have. A handoff must carry the bytes anyway, and
    `render --job` on another machine needs the file found and checked.
  - `io.video` and `io.read` in both hosts and the web player would need a second way to
    resolve a file.
  - That is a new concept and new failure paths, to save the one object per trim that `prune`
    already removes. Revisit if a measured project still grows past about twice its media after
    this ADR, #474 and a prune.
- **Chunked or delta storage of objects.** A re-trim is re-encoded, so it shares almost no bytes
  with the trim before it. Chunking would add a format to every read and save nothing.
- **Hard links without read-only.** One stray in-place write would corrupt history. Read-only
  costs one `chmod`.

**Consequences.**
- On Windows, objects become read-only files. `prune` still deletes them: Node's `rmSync`
  removes a read-only file on Windows (tried), and removing a frozen copy that links them leaves
  them read-only. A tool that
  rewrites `versions/` by hand now gets `EPERM`.
- Links need the same volume. The frozen copies and `versions/` are both inside the project, and
  revisions never follow links (0003), so they always are. When a link fails anyway (`EXDEV`,
  `EPERM`), the file is copied.
- NTFS allows 1023 links per file. One object is linked once per frozen copy, and few frozen
  copies are kept, so this limit is never reached.

**LOC impact.** About 40 lines: the clone, link or copy function, its use in `store`, `checkout`
`chmod` on new objects, and `nlink` in `prune`'s byte count.

**How to reverse.** Place every file by copy again. The objects can stay read-only or be made
writable. Nothing on disk changes format.
