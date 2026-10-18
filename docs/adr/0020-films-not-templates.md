# 0020: Films, not templates, on shaderera.com

2026-10-18. Owner decided. Amends [0019](0019-templates-on-shaderera-com.md).

**Context.** 0019 put templates on shaderera.com: published films whose declared params a viewer
changes in the browser, each showing its source. The same day, the owner redesigned the site as a
visual search of film frames: a masonry of stills, each opening its film at that moment. A
separate kind of film called a template no longer fits that shape. Every film on the site is just
a film.

What did separate films was whether their source was public. A film whose source is public can
be forked. A film whose source stays private cannot, and may later be what the site sells.

**Decision.**

1. **shaderera.com lists films.** The word "template" is retired from the site and the glossary.
   There is no `/templates` and no template flag.
2. **Every film's declared params can be changed in the browser, and every film can be
   exported.** This is unchanged from 0019, and it applies to every film.
3. **A forkable film is one whose source is shared with it.** Its page shows the source and the
   fork command. The engine's `shaderera share` makes forkable films: it sends the source with
   the player (0019, point 4).
4. **Films that cannot be forked are not built now.** A film shared without its source would be a
   new kind of share and possibly a paid one. Neither is decided here.
5. **0019 stands otherwise.**
   - The engine stays for experts (0011).
   - Forking is a command of the one CLI.
   - The listing rules (plays live, licences named, at least one param) no longer gate a
     template. They become what a film needs in order to be featured.

**Consequences.**
- The site's `/templates` page and its copy go. The front page is a search over film frames.
- The glossary drops **Template** and gains **Forkable film**.
- `shaderera share` is unchanged.
