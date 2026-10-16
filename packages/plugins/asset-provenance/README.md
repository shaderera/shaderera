Where each file from outside the project came from: one record per file with its source page, licence, author, segment and sha256, made into the ASSETS.md table and the video description's credits.

```sh
node tools/provenance.ts record assets/footage/wheat.mp4 \
  --source https://www.pexels.com/video/golden-wheat-field-36080123/ \
  --licence "Pexels License" --author "Sudheir Kumar" --title "Golden wheat field" --segment 0,7
node tools/provenance.ts credits     # ASSETS.md (between its markers) and out/credits.txt
```

Record a file when it arrives, after it is trimmed or converted: the hash is of the file the film
reads. Recording it again (after a new trim) replaces its record.

**A record** is `provenance/<file path>.json`, format `shaderera.provenance/1`: `file`, `sha256`,
`source` (the page it came from, not a CDN link; or who supplied or made it), `licence`, `author`,
`title`, `segment` (the seconds of the source the file holds), `credit` (the line shown on screen;
`<title>, <author> · <licence>` unless you give `--credit`), `fetched` (today unless you give
`--fetched`) and `flags` (`--flag`, any word worth knowing, such as `ai-generated`,
`overlay-cropped` or `share-alike`). One file per asset, so agents working at the same time never write the same
file. It holds rights only: what the file is for in the film stays in the film's code. The film
never reads a record.

**credits** writes:
- a table of every record, its flags beside its licence, into `ASSETS.md` between its two
  `asset-provenance` markers, added at the end the first time. The rest of the file stays as
  written, so voice, fonts and notes can sit around it. Running it again gives the same file.
- `out/credits.txt` (`--out`), for the video's description: each credit with its source page,
  once however many files were cut from the same work, then a share-alike note for each
  share-alike licence used (one whose name says so, or a record flagged `share-alike`).

A file the person supplied or a tool made is recorded too, with that as its source
(`--source "supplied by the person"`, `--licence "the person's"`), and `--credit ""` keeps it in
the table but out of the description's credits.

Whether a film uses outside media at all is the person's call. Licences and what they cost on
screen: `guides/footage.md`.
