# 0013: The engine is MIT; the name stays ours

2026-10-12. Owner decided. Supersedes the licence part of
[0010](0010-engine-licence-and-public-history.md).

**Context.** 0010 put the engine (`@shaderera/core`, `shaderera`, `@shaderera/registry`) under a
draft Shaderera License: free for individuals and small teams, a company license for everyone
else. The owner then wanted it free for everyone, and weighed licences that are free except for
use inside a software product (BSL 1.1, FSL-1.1, PolyForm Shield). They are source-available, not
open source, and every company has to read them with a lawyer.

**Decision.** Everything in the repository is MIT, the engine included: one `LICENSE` file, and
`"license": "MIT"` in every package. Anyone may use the code for anything, including inside a
product they sell. The name "Shaderera" and its logo are not covered by the MIT licence
([TRADEMARKS.md](../../TRADEMARKS.md)): a product may use the code, but not call itself Shaderera
or suggest that the official project made it.

**Consequences.**
- No licence question stands between a company and using Shaderera, so adoption is as easy as it
  can be. The project's value is protected by its name, its catalog and its work, not by its
  licence.
- The `v0.1.0` tag was published under the draft licence, as source only, and never reached npm.
  0.1.1 is the first MIT release, and the first on npm.
- Outside contributions would come in under MIT, the same as the code. CONTRIBUTING still takes
  issues only for now.
