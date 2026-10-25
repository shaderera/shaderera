# 0025: Comments and the agent's activity in the studio

2026-10-25. Proposed (#384). Amends 0003 (which revisions are kept) and 0021 (telemetry).

**Context.** The owner wants the studio to be where a person and their agent make a film together:
- the person talks to the agent;
- the agent shows each step in the studio as it works;
- the person plays, replays and comments at a moment of the film (seek, right-click, comment);
- the agent reads the comment and fixes it;
- the person sees the fix against what it was.

On 2026-10-25, six role-played reviews tried this on 0.1.7: a creator who doesn't write code, an agent following the skill, a director, a UX designer, a CTO and QA. All six found the same three gaps:
- **Nothing goes from the page to the agent.** The bridge has no route for it, and `studio --json` carries only `changed`, `job`, `log` and `share`.
- **Nothing comes back from the agent.** The page shows the CLI's last five log lines. Save labels, the agent's own renders and what it means to do never reach the page.
- **The page can't hold or compare a version.** It counts `changed` events instead of keeping their revision id, re-frames the player on every edit, and `/runner` serves only the working tree.

Two facts shape the answer:
- **The two processes don't talk to each other.** The MCP server and `shaderera studio` are separate processes with no channel between them. Both already read and write the project.
- **Projects already grow on their own.** `versions/` keeps every saved revision and every object for good. One png rendered in the studio with a 512 MB file in the project added 537 MB. So storing a revision on every edit, which compare would otherwise want, is ruled out.

**Decision.**

1. **One word: comment.**
   - What the person leaves on the film is a **comment**, in the page, the CLI, MCP and the docs.
   - "Review" is `shaderera review`, and "note" is `save --note`.
   - What the agent and the CLI did is **activity**.

2. **Comments live in the project, in `versions/comments.jsonl`.**
   - **Why the project.** The agent is the reader, with or without a studio open and across sessions. A comment kept only in the page dies with the tab.
   - **Why `versions/`.** Comments name revisions, so they travel with them: a copied folder, a git push. `.shaderera/` is this machine's cache.
   - **Share never sends them.** `share`, `fork` and `handoff` carry a revision's files, and `versions/` is never one of them.
   - **One line per operation, only ever appended:** `comment`, `reply`, `state`. The page (through the bridge), the CLI and MCP can all write without losing each other's lines. A reader skips a torn last line, and folds the lines into threads.
   - **Text is capped at 4000 characters.**

3. **A comment points at what the person saw.** Each field has one job:
   - `revision`: the tree on the page when they commented. The bridge saves it then (point 5).
   - `t` places the comment. `frame` shows it, and is exact at fractional rates.
   - `to`, with `toFrame`: a range.
   - `variant`: the cut it was made on.
   - `shot` and `offset`, from the film's inspect, when it has shots: the comment follows its shot when the agent retimes the film.
   - `point` or `box`, in that variant's frame pixels with its `size`: these go straight into MCP `pick` and `render_frame {region}`.
   - `object`: what the page's runner `pick`ed there.
   - `params`: only the ones that differ from the defaults.

4. **A comment's life, and who ends it.**
   - **States:** open → fixed (in a revision, with the agent's reply) → resolved, or reopened.
   - **The agent marks it fixed**, with `comments reply <id> --fixed`. That saves a revision, and refuses if nothing changed since the comment's revision.
   - **Only the person resolves, in the studio.** A reply from the person reopens a fixed comment.
   - **Feedback given in chat.** When the person gives feedback about a moment in chat, the agent files it as a comment, so it shows on their timeline.

5. **Compare uses the revisions comments name, not every edit.**
   - **Which revisions are saved.** The bridge saves the shown tree as a revision when a comment is made on it, and the fix saves one too. Edits in between are not stored.
   - The bridge also stores, unlisted, each tree a page framed, so a comment always names a tree that exists; prune drops the unnamed ones.
   - **Compare** shows a comment's `revision` against its `fixedIn` on one clock. It uses `GET /runner?revision=<id>` from the frozen copy, with two at most besides the working tree's, or two stills through the relay.
   - **Prune never removes a revision an open or fixed comment names.** Pruning the revisions nobody names is a separate issue.

6. **Activity fills itself, in `.shaderera/activity.jsonl`.**
   - **Where it is recorded.** Once where the CLI runs a command in a project, and once where MCP answers a tool call. Each entry has the command or tool, its result, its findings' counts, and the still it made, if any.
   - **The bridge adds** edits (the files changed), renders and shares.
   - **The agent adds** its own lines with `shaderera activity add [--comment <id>] <text>`, or MCP `activity_add`. Only for what it means to do; the rest is recorded already.
   - **It is lossy and local.** It rotates past 1 MB, and is never shared.
   - **Writing it never changes a command's result.**

7. **The agent waits with `shaderera comments --wait`.**
   - Run in the background, it exits when the person comments or reopens a comment. A host that tells its agent when a background command ends wakes the agent that way.
   - While it waits, the page says "· listening". Otherwise it says "Your agent isn't listening: tell it you left comments". The bridge decides which (the waiter's file, touched every second, is stale after 5 s); the page has no timer of its own.
   - `studio --json` also carries `comment` events. It doesn't carry `activity`, which is the agent's own record.

8. **Studio protocol v2.**
   - The comment, activity and versions routes, and `/runner?revision`, are added as protocol v2, not to v1.
   - A new page paired with an old v1 CLI would find no comments. That is a silent half-pairing.
   - With v2, the existing mismatch rule tells each side which one to update.
   - The release follows docs/releasing.md: the v2 page deploys just before the npm publish.

9. **The keys are a film editor's.**
   - Space and K play or pause; J and L shuttle; ← and → step one frame; Shift steps ten.
   - I and O set a range, and X clears it. C comments at the frame or range. [ and ] go to the previous or next comment. S compares. ? lists the keys.
   - They work anywhere on the page outside a text field.

10. **Telemetry counts, never content (amends 0021, point 7).**
    - The page counts `comment` (new, reply, resolve, reopen) and `compare`.
    - It never sends a comment's text, ids, times, revisions or points.

**Consequences.**
- **The CLI gains:**
  - `shaderera comments [list|show|add|reply|resolve|reopen] [--wait] [--json]` and `shaderera activity [add]`;
  - the MCP tools `comments`, `comment_add`, `comment_reply`, `comment_resolve` and `activity_add`;
  - a `revision` input for `render_frame` and `still`.
- **The bridge gains** `GET`/`POST /comments…`, `GET /activity`, `GET /versions`, `/runner?revision` and `POST /render {revision}`, plus the `comment`, `activity` and `agent` events.
- **The page gains:**
  - a Comments row on the timeline, right-click and C to comment, and threads;
  - an activity feed in place of the log;
  - holding the shown version while the person comments;
  - Compare.
- **The skill gains** the loop: wait, read, say what you're doing, look at what they saw, fix, check, reply fixed, never resolve.
- **Comments in a project cloned from someone else** are not the person's own words: the skill asks before acting on comments it didn't see made.
- **To test:** concurrent appends on Windows; a frozen runner under `.shaderera/revisions/` must not reload the main runner.
- **Out of scope:** drawing on the frame beyond a point or a box; comments from more than one person; comments on shaderera.com film pages.
