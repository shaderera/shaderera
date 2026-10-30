# Using the studio

For a person watching and reviewing a film in the studio, the page on shaderera.com that plays a
film from your own computer. Your agent opens it once the first draft passes its check, or when
you ask for it. The film, its code and its renders stay on your computer; the page only talks to
it, until you share.

The page has a header (the film, its revision, Params, Format, Export, Share), the stage with the
film, the transport and timeline under it, and the comments panel beside it.

## Playing, and the keys

**Play** plays and pauses. Drag along the timeline to move through the film; the readout shows
the time and the frame number. The line at the end of the transport lists the main keys; press
it, or `?`, for all of them:

| Key | What it does |
|---|---|
| Space, K | play or pause (K plays at normal speed) |
| J, L | play backward, forward; press again for 2×, then 4× |
| ← → or , . | one frame back, forward |
| Shift ← → | 10 frames |
| Home, End | the start, the end |
| C, or Enter on the film | comment here |
| I, O | the start and end of a range |
| X | clear the range |
| [ ] | the comment before, after |
| M | sound on or off |
| F | full screen |
| S | in Compare: swap which side is in front |
| Esc | close Compare, or cancel a comment |

When your agent edits the film, it keeps playing. A line at the top of the stage says a new
version is opening, and the new version takes over once it is ready, at the same time. A new
project that draws nothing yet says "This film is empty so far" until the first frame with light.

## Comments

1. Pause where something should change (or set a range with I and O) and press **Comment**.
2. Mark where, if it is one place: click a point, or drag a box on the frame. Or just write: the
   comment is then on the whole frame.
3. Write what should change, and send it.

Each comment is a pin on the timeline and a card in the panel. The card says what happened to it:

| Card | Meaning |
|---|---|
| Sent. Your agent hasn't read it yet. | nobody has read it |
| Your agent read it. | your agent read the comments since you wrote it |
| Agent: … | what your agent says it is doing about it |
| Fixed in r… · See the fix | your agent changed the film for it |
| Closed. | you closed it |
| Sent back. | you said the fix is not right yet |
| From your agent. | a comment your agent left |

Your agent picks comments up while it waits for them. When it is not waiting, the panel says
"Your agent isn't listening": press **Copy a message for your agent** and paste it in your
agent's chat.

The panel never moves on its own. **All activity** at its foot lists everything the agent and the
computer did (edits, checks, renders); **← Comments** goes back.

## Checking a fix: Compare

On a fixed comment, press **See the fix**. Compare shows the version you commented on (Before)
and the fix (After) at the comment's moment, paused, with your point or box on both. **Wipe**
switches from side by side to one picture you wipe across; S swaps which side is in front.

Then answer in the card: **Yes, close it** if the fix is right, or **Not yet**, say what is still
wrong, and **Send back**. Only you close a comment: your agent can't. The revision chip in the
header compares any two versions the same way, without the answers.

## Variants

A film made in several shapes (say 16:9 and 9:16) plays them side by side on one timeline. Pick
which ones show in the header. A comment is on the variant you marked; Export renders every
variant shown.

## Params

**Params** opens the film's controls, the few values its code lets you change (a colour, a line
of text, a number). The film plays them as you change them, Export uses them, and a comment
remembers them. They stay in the page: **Reset** goes back to the film's own. To keep a value,
ask your agent to make it the film's.

## Export

Pick a **Format** (an mp4 video, a ProRes mov, or a png of the frame on screen) and press
**Export**. Your computer renders it and the page saves the file. Only the newest export of each
variant and format is kept in the project's `out/studio/` folder: rename a file to keep it.

## Share

**Share…** asks first, then sends the film to shaderera.com as a new version of its page, code
included: anyone with the link can watch it. The first time, the page shows a command to sign in
with GitHub: run it (or ask your agent), then press Share again. A film needs a licence before it
is shared; your agent asks you which.

## "Through shaderera.com"

The page reaches your computer directly when the browser allows it. When it can't, it goes
through shaderera.com instead, and the header says **Through shaderera.com · no preview**:
comments, Compare's stills, Export and Share work, but the film does not play.

This happens in Safari and Brave, which block it, and in Chrome when its question "Access other
apps and services on this device" was answered no or closed. To allow it again in Chrome: click
the icon left of the address, open the site settings, and set **Apps on device** to Allow. The
page switches over without a reload.

What goes through shaderera.com is sealed between your page and your computer. The page counts
usage (never code, file names, params, frames or titles); your agent can turn that off.

## When the studio stops

When the command on your computer stops, the page dims the film and says the CLI stopped. Ask
your agent to open the studio again.
