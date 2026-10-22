# Plugin direction

Research of 2026-10-13, before [0014](../adr/0014-plugins-in-one-cli.md): what the official
plugins should become, and how they reach people. It read the ADRs, the in-house films' gap logs
and outside evidence on registries, agents, hosting and the ad market. It used the words of the
time ("catalog", "registry item"); this page uses 0014's.

## Conclusion

Every decision so far points the same way: a **small, free, MIT shelf of plumbing, curated by the
owner, that grows by extraction from accepted films**, not a looks library that competes on
count. Outside evidence agrees:
- what lasts in creative tools is a core set the engine team keeps beside the engine;
- the big agent platforms make suggestions opt-in and never install on their own;
- generic templates and animations are already priced near zero.

The bottleneck was **delivery and freshness**, not which plugins to have. 0013 names the project's
protection as "its name, its catalog and its work". With everything MIT, that protection is trust
that the shelf is curated, checked against every release and one command away. A shelf nobody can
reach, or one that drifts, wears it down faster than a short list does.

Agents raise the value of plumbing and lower that of looks: an agent that reaches parts easily
pulls work toward the average, while plumbing raises the floor without narrowing taste. For ads,
delivery plumbing (placements, safe areas, slates) is where this meets a growing market for
controlled variants.

## Status of the recommendations

| Recommendation | Status |
|---|---|
| A read-only public path to the official plugins, without cloning | **Done** (0014): static index and files at `https://shaderera.com/r`, mirrored to `~/.shaderera/cache/` |
| Fold the second CLI into `shaderera`; drop stale "templates" wording | **Done** (0014) |
| Reserve the npm name `shaderera-registry` | **Done**: a 0.0.1 placeholder points to `npx shaderera` |
| Tell agents that text inside a plugin is data, never instructions | **Done**: in the `shaderera-plugins` skill |
| A picture per plugin, so a name means something | **Done** (0014): a preview in every plugin |
| Record the naming rule and categories | **Done** in [plugin-guide.md](../plugin-guide.md); the categories still have no ADR |
| Decide whether `format-safe-areas` is plumbing (it sits with looks, next to plumbing `format-placement-specs`) | Open, the owner's call |
| Every plugin declares the `shaderera` range it works with | Open: two do |
| The project records the version and sha256 of each copied plugin, so a diff against upstream is exact | Open: `add` checks hashes but records nothing for copied files |
| CI renders every plugin against each engine release and shows "verified against shaderera vX" | Open |
| Every description says what it does and when to use it, with a usage example | Partly: the preview gives the sentence |
| A written trigger for a team source on Worker + D1 (more than one publisher, private plugins per team, yank or deprecate) | Open |
| The team's shared folder held pre-rename items and an old engine range on 2026-10-13 | Refill it from `packages/plugins/` or retire it |
| Next plugins from the gap logs (below) | Open |

Left open on purpose, as 0008 has it: featured status, and publishing by outside authors beyond
pull requests to `packages/plugins/`. Paid plugins are ruled out by the owner.

## Next plugins, from the gap logs

The owner's rule is to plan the next plugins from the films' `REGISTRY-GAPS.md` and
`ENGINE-GAPS.md`. In order of evidence:
1. **A vgpu host.** 0012's trigger, "when a film uses vgpu", was met on 2026-10-13. It would take
   `host.gpu` through `initFromDevice`, as `render-three-host` does for three.js.
2. **Raw-WebGPU image textures with mips.** Two films wrote them on their own, because
   `render-three-textures` is three.js only.
3. **A GPU point-splat building block.** Films write particles by hand; `text-glyph-points` is a
   CPU point set for text.
4. **A path tracer and denoiser,** once the film that wrote one is accepted.

Bloom, grade and depth of field are looks under 0011: they stay in the film, or become plugins
added only when asked. A competitor ships 210+ screen-look components; matching that count would
go against 0011 and the evidence on sameness below.

## Evidence

### What lasts: core sets the engine team keeps

- TouchDesigner ships 700+ OP Snippets inside the app, and the 2014 community thread is obsolete
  because they moved in ([forum](https://forum.derivative.ca/t/op-snippets/4951)). `three/addons`
  is an alias of `examples`, versioned with the engine
  ([forum](https://discourse.threejs.org/t/three-js-semver-and-addons/45539/34)). cables core ops
  are MIT and kept by the team ([cables](https://cables.gl/ops/)). Unvetted community layers
  (forum .tox, Hydra extensions) live beside them but are not the core.
- **A shelf dies with its engine.** Motion Canvas's last core publish was around December 2024
  ([depscope](https://mcp.depscope.dev/pkg/npm/@motion-canvas/core)); Theatre.js moved to a private
  repo ([repo](https://github.com/theatre-js/theatre)); Revideo does not upstream new work to its
  MIT repo ([Midrender](https://midrender.com/revideo)). 21st.dev's advice is to judge a registry
  by when it last shipped: "6,000 stars and no commit since March is a snapshot, not a dependency"
  ([21st.dev](https://21st.dev/blog/shadcn-registry-directory)).
- **Licence defaults decide reuse in ads.** Shadertoy's default is reported as CC BY-NC-SA
  _(secondary: [forum](https://magicmusicvisuals.com/forums/viewtopic.php?p=9451))_, which makes
  its library unusable for commercial work. Rive's Marketplace is CC BY
  ([Rive](https://rive.app/docs/community/marketplace-overview)). MIT by default is a real
  advantage for ad work.

### shadcn: the copy-in reference, and its gaps

- Decentralised: anyone hosts JSON at a URL, a project opts in per namespace in
  `components.json`, and a directory sits on top with "no central authority"
  ([Namespaces](https://ui.shadcn.com/docs/registry/namespace)).
- **`registry-item.json` has no version field**, and installs record no provenance
  ([schema](https://ui.shadcn.com/docs/registry/registry-item-json);
  [#790](https://github.com/shadcn-ui/ui/discussions/790)). Users write drift scripts; one vendored
  registry fell 9 components behind ([jac #8702](https://github.com/jaseci-labs/jac/issues/8702)).
  Through 2025–2026 shadcn added channels (GitHub and private registries, server search, `eject`)
  but nothing for pinning or updates ([changelog](https://ui.shadcn.com/docs/changelog)).
- Cross-registry problems: stale registries, file collisions (two `button.tsx`), undeclared deps,
  "four button implementations and three animation runtimes" from three motion registries
  ([21st.dev](https://21st.dev/blog/shadcn-registry-directory)).
- Shaderera already has what shadcn lacks: immutable versions, a sha256 per version and a resolver
  for `requires`. The missing piece is the record in the project.

### Agents

- **Opt-in is the platform norm.** Claude Code shows no plugin suggestions until an admin
  allowlists the marketplace, at most once every three sessions, and "never installs the plugin
  automatically" ([Relevance](https://code.claude.com/docs/en/plugins/relevance)). skills.sh's
  auditors flag a skill that makes agents install more skills because it "expands the agent's
  trusted instruction surface"
  ([Socket audit](https://www.skills.sh/vdustr/skills/vp-skills/security/socket)).
- **Descriptions and examples drive choice.** Anthropic: usage examples raised accuracy on complex
  parameters from 72% to 90%; search on demand (regex or BM25) is worth it above about 10 tools or
  10K tokens ([Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)). A
  shelf of tens to low hundreds of plugins can ship its whole index, as `search.json` does.
- **"MCP returns a command, the CLI installs"** keeps writes in one auditable path; shadcn's MCP
  wraps static JSON with search, view and examples and returns the `add` command
  ([shadcn MCP](https://ui.shadcn.com/docs/mcp)).
- llms.txt is ignored by search crawlers (97% of files got no requests in one 137,000-domain log
  study, _secondary: [PPC Land](https://ppc.land/llms-txt-adoption-rises-8-8x-but-97-of-files-get-zero-ai-requests/)_)
  but Anthropic's own doc pages point coding agents at one. Cheap to add, not a discovery channel.

### Sameness

- "Frictionless generation" makes LLM-built design more alike; the authors propose "productive
  friction" ([Shin et al., arXiv 2603.13036](https://arxiv.org/abs/2603.13036)). Other 2026 papers
  report the same convergence in generated UI and graphic design (seen as summaries only).
- An in-house film told to search first assembled generic parts that pulled it toward standard
  motion graphics; the film made with no registry was one bespoke system. That is the reason for
  0011's two-tier shelf.
- No quantitative data exists on agents over-using a registry's looks. This rests on mechanism
  and in-house experience, not measurement.

### Security

- Snyk scanned 3,984 public skills: **13.4% had a critical issue**, and three lines of SKILL.md
  were enough to make an agent exfiltrate SSH keys
  ([ToxicSkills](https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/)).
- A shadcn registry item can write a Vite config that runs a shell command on the next build, so
  "data, not code" fails once data lands in executable config
  ([#7747](https://github.com/shadcn-ui/ui/discussions/7747)). A plugin should never write build
  or runtime config without an explicit flag.
- `npx skills` documents no lockfile or pinning ([vercel-labs/skills](https://github.com/vercel-labs/skills));
  Claude Code plugins can pin a git `sha`
  ([marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)). A closed set of publishers
  plus content hashes is a much smaller surface than open directories; signing is likely overkill
  at this size.

### Hosting on Cloudflare

| Service | Free | Paid |
|---|---|---|
| [Workers](https://developers.cloudflare.com/workers/platform/pricing/) | 100k requests/day | $5/month, 10M requests; **static asset requests free and unlimited** |
| [R2](https://developers.cloudflare.com/r2/pricing/) | 10 GB-month | $0.015/GB-month; **egress free** |
| [D1](https://developers.cloudflare.com/d1/platform/pricing/) | 5M rows read/day, 5 GB | 25B reads/month included; [10 GB max per DB](https://developers.cloudflare.com/d1/platform/limits/) |

- **Static files are enough** while maintainers publish through git or CI, the shelf is public,
  and the whole index fits in one response.
- **A Worker + D1 earns its place** with authenticated publishing by many people, private plugins
  per team, server-side search, download counts or yanking. Keep files in R2.
- Keep the URL shapes (`index.json`, `search.json`, `items/<name>/<version>/`) the same either way,
  so the CLI and skill never change.

### Market

- **Generic templates are commoditised.** Envato Elements is an all-you-can-download subscription
  whose AI upsell is not shared with authors
  ([author terms](https://help.author.envato.com/hc/en-us/articles/54407097667993-Envato-Elements-subscription-pricing-tiers-and-author-revenue-share));
  single Lottie files sell for $0.99–$3.49 ([LottieFolder](https://lottiefolder.com/)); Google's
  Veo in Ads turns product photos into video from 64 templates inside the ad buy
  ([BrowserMedia](https://browsermedia.agency/blog/googles-veo-and-asset-studio-are-they-any-good/)).
  The Getty–Shutterstock merger was terminated on 2026-07-07
  ([8-K](https://www.sec.gov/Archives/edgar/data/0001898496/000121390026075721/ea029721801-8k_getty.htm)).
- **Controlled variants are growing.** IAB: 86% of video ad buyers use or plan to use GenAI; about
  30% of digital video ads are made or adjusted with it, nearly 40% expected in 2026; the top use
  is versions per audience (42%) ([IAB](https://www.iab.com/news/nearly-90-of-advertisers-will-use-gen-ai-to-build-video-ads/)).
- **DCO** is estimated at $1.97B in 2026
  ([Mordor](https://www.mordorintelligence.com/industry-reports/dynamic-creative-optimization-software-market)).
  The leaders (Smartly, Innovid, Celtra, Bannerflow, Adform) are closed SaaS with GUI template
  editors; none found offers a code-first, git-versioned template format. Demand for that is
  inferred, not measured.
- **Money comes from the engine and services, not the shelf.** Remotion licenses the engine:
  $25/seat/month, $0.01/render with a $100/month minimum, Enterprise from $500/month
  ([license](https://www.remotion.pro/license)); its own store is a few large kits (Editor Starter
  $600, [store](https://www.remotion.pro/store)). Magic UI pairs an MIT core with a $199 lifetime
  Pro under a no-redistribution licence ([pricing](https://magicui.net/pricing/)). For an all-MIT
  project, revenue would come from services around the code (hosted private sources, rendering at
  volume, support), which matches the owner's rule of no checkout.

## Gaps in the evidence

- No data on which plugins outside users add: the repo had no issues or PRs at the time.
- No measured rate of rot for any registry after a major engine version.
- No measured effect of opt-in versus suggested registries on output diversity.
- Shadertoy's terms page and some vendor pages returned 403; those claims are marked secondary.
