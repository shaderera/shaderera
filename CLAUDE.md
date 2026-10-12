# Shaderera

pnpm monorepo, Node 24: `pnpm install`, `pnpm build`, `pnpm test`, `pnpm lint`. The packages and
docs are listed in [README.md](README.md); terms are in [GLOSSARY.md](GLOSSARY.md); decisions in
[docs/adr/](docs/adr/).

`docs/authoring.md` and `docs/guides/` are copied into every new project, and the top-level
`docs/*.md`, `docs/participants/` and `docs/guides/` ship in the `shaderera` package: keep them
self-contained.

## Agent skills

### Issue tracker

GitHub Issues on `shaderera/shaderera`, through `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the root. See `docs/agents/domain.md`.
