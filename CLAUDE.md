# Shaderera

pnpm monorepo, Node 24: `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`.
The packages and docs are listed in [README.md](README.md) (Develop says what the tests need);
terms are in [GLOSSARY.md](GLOSSARY.md); decisions in [docs/adr/](docs/adr/README.md).

`docs/authoring.md` and `docs/guides/` are copied into every new project, and the top-level
`docs/*.md`, `docs/participants/` and `docs/guides/` ship in the `shaderera` package: keep them
self-contained.

## Agent skills

`.claude/skills/` holds third-party engineering skills copied for contributors' agents (ponytail
and mattpocock/skills, listed in `.claude/skills/SOURCES.md`); `npx skills add` does not offer
them. The Shaderera skills are in `plugins/shaderera/skills/`.

### Issue tracker

GitHub Issues on `shaderera/shaderera`, through `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.
