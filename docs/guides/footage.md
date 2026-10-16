# Footage and pictures from outside

For requests whose brief or person asks for footage, photographs or artworks from outside the
project: stock clips, museum collections, archival film. A film uses outside media only when it
is asked for; drawing the picture in code is never the lesser choice, and how many outside files a
film shows, and where, is the film's direction.

## Find

Search with the subject and the medium in English (`wheat field`, `cat statue Egypt`). Each source
has an official API; the date says when the call was last run. When one fails or has changed, say
so, and use another.

| Source | Good for | Call | Verified |
|---|---|---|---|
| Wikimedia Commons | public-domain art, early films, photos, institutional video | `commons.wikimedia.org/w/api.php?action=query&list=search&srnamespace=6&srsearch=<terms> filetype:video` (or `filetype:bitmap`); then `prop=imageinfo&iiprop=url\|size\|extmetadata&iiurlwidth=3840&titles=File:<name>` | 2026-10-16 |
| archive.org | films from 1930 or earlier, public-domain collections | `archive.org/advancedsearch.php?q=<terms> AND mediatype:movies&fl[]=identifier&fl[]=licenseurl&output=json`; files from `archive.org/metadata/<identifier>` | 2026-10-16 |
| The Met | art and artifacts, CC0 | `collectionapi.metmuseum.org/public/collection/v1.1/search?q=<terms>&hasImages=true`; then `/v1/objects/<id>` → `isPublicDomain`, `primaryImage` | 2026-10-16 |
| Cleveland Museum of Art | prints, drawings, Asian art, CC0 | `openaccess-api.clevelandart.org/api/artworks/?q=<terms>&cc0=1&has_image=1` → `images.print.url` | 2026-10-16 |
| Rijksmuseum | paintings | `data.rijksmuseum.nl/search/collection?type=painting&description=<Dutch terms>&imageAvailable=true`; each item's JSON (`Accept: application/ld+json`) names its `iiif.micr.io/<id>`; the image is `iiif.micr.io/<id>/full/!4000,4000/0/default.jpg` | 2026-10-16 |
| Art Institute of Chicago | paintings, prints, CC0 | `api.artic.edu/api/v1/artworks/search?q=<terms>&fields=id,title,image_id,is_public_domain`; the image is `www.artic.edu/iiif/2/<image_id>/full/843,/0/default.jpg`, fetched with an `AIC-User-Agent: <name> (<contact>)` header | 2026-10-16 |
| Pexels | modern b-roll | with `PEXELS_API_KEY`: `api.pexels.com/videos/search?query=<terms>&orientation=landscape`, header `Authorization: <key>` → `videos[].video_files[]` | 2026-10-16 (answers; refuses without a key) |
| Pixabay | modern b-roll | with `PIXABAY_API_KEY`: `pixabay.com/api/videos/?key=<key>&q=<terms>` → `hits[].videos.large.url` | 2026-10-16 (answers; refuses without a key) |

On Commons, categories and structured data find more than words (verified 2026-10-16): find a
category's name with `list=search&srnamespace=14&srsearch=intitle:cats Thailand` rather than
guessing it, list its files with `list=categorymembers&cmtitle=Category:<name>&cmtype=file`, and
search what a file depicts with `srsearch=haswbstatement:P180=<Wikidata id>` (`Q146` is the house
cat).

Without a key, leave out Pexels and Pixabay and say so; never fetch their pages to get around it.
Send a `User-Agent` that names the project. Commons answers 429 to fast loops: pause about 4 s
between calls (1.5 s and 3 s were refused within a dozen calls), keep to one download at a time,
and ask for `iiurlwidth=3840`, which returns a 3,840 px copy of a picture (or the original when it
is narrower). Ask for a file's licence with `prop=imageinfo` alone: combined with `videoinfo` it
comes back without `extmetadata`. Check the first bytes of every download: an
HTML page (`<!DOCTYPE`) is a refusal, not the file. When a site shows a "verify you are human"
page, stop: use another source, or ask the person for the file.

## Look before keeping

- Pictures: a numbered contact sheet of the candidates, then the full-size crop of what the shot
  needs. Stills to be pushed into want about 3,000 px on the long side.
- Clips: a sheet at 1–2 fps, then 4–10 fps over the stretch with the action, so the moment the
  shot needs falls inside the segment kept.
  `ffmpeg -i clip.mp4 -vf "fps=2,scale=240:-1,tile=8x5" -frames:v 1 sheet.jpg`
  For a long film on Commons, make the sheets from a small transcode
  (`prop=videoinfo&viprop=derivatives` lists them) and download the original only for the
  segments kept.
- Trim to the segment used, and note it:
  `ffmpeg -ss <from> -t <seconds> -i source.mp4 -an -c:v libx264 -crf 18 assets/footage/<name>.mp4`
- Look for burned-in logos, subtitles and watermarks, and for a label saying the clip is
  AI-generated (Pixabay shows one on the page). Crop them out or leave the clip, and note what you
  did in its record (Record, below).
- When nothing matches the moment the brief names, keep the nearest only if it serves, and say
  what differs; or ask the person for a file.

## Licences

| Licence | On screen | In the description |
|---|---|---|
| CC0, public domain | a credit anyway, by convention | — |
| CC BY | author and licence | — |
| CC BY-SA | author and licence | a share-alike note (Record, below, writes it) |
| Pexels, Pixabay | the author and the site, by convention | — |
| NC (non-commercial) | not in an ad or any film made for money | — |
| ND (no derivatives) | only as it is: no crop, trim or grade | — |
| copyrighted (film clips, memes) | only a file the person supplies, on their decision | as they decide |

Read the licence on each item, not on the collection. archive.org's top hits are often re-uploads
of videos from other sites; check `licenseurl` and who uploaded it. Manuscript libraries mix CC0,
CC BY-SA and NC by manuscript. Films from 1931 on may still be under copyright in the US; early
cartoons can hold gags worth watching for before use. A Commons `Artist` field is HTML: credit the
name it shows. A Commons file imported from YouTube or Flickr may carry a licence review that is
still pending: its licence is the uploader's claim until a reviewer confirms it. Keep it only with
`--flag licence-review-pending`, and tell the person.

## Record

Every kept file gets a provenance record as soon as it is trimmed or converted. Add the
`asset-provenance` plugin: it is plumbing, so add it without asking and say so in your summary.
Its script runs with node from the project root:

```sh
node tools/provenance.ts record assets/footage/wheat.mp4 --source <the item's page> \
  --licence "CC BY 4.0" --author "<name>" --title "<title>" --segment <from>,<to> \
  [--flag overlay-cropped] [--flag ai-generated]
node tools/provenance.ts credits    # the ASSETS.md table, and out/credits.txt for the description
node tools/provenance.ts check      # before a render you deliver: every file recorded, unchanged
```

The source is the item's page, not the download link. The film still shows each credit on screen
in its own way; the record keeps the line (`--credit`).
