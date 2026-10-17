# Releasing

The repository went public at 0.1.0; 0.1.1 is the first release on npm. The three packages
(`@shaderera/core`, `shaderera`, `create-shaderera`) share one version. A release is checked as a
user gets it: from packed tarballs, installed with npm in a fresh folder outside the monorepo.

1. **Build and test.** `pnpm install`, `pnpm build`, `pnpm test`, `pnpm lint`.
2. **Pack.**
   ```bash
   pnpm --filter @shaderera/core --filter shaderera --filter create-shaderera \
     pack --pack-destination ../release
   ```
   Check that `create-shaderera`'s tarball holds `files/project/`, `files/AUTHORING.md`, the nine
   `files/guides/*.md`, `files/skills/shaderera/SKILL.md` and
   `files/skills/shaderera-plugins/SKILL.md`, and that `shaderera`'s holds `guides/` (nine files)
   and `docs/` (the reference, with `participants/` and `plugins.md`).
3. **A clean folder.** In a folder outside the monorepo:
   ```bash
   npm exec --package=<create-shaderera.tgz> -- create-shaderera film
   cd film && npm install <core.tgz> <shaderera.tgz>
   npx shaderera check
   npx shaderera still 0 5 --sheet --diff
   npx shaderera job --name release
   npx shaderera deliver
   npx shaderera handoff release --verify
   npx shaderera doctor
   ```
   Every command must pass. The empty project needs WebGPU, so a GPU adapter.
4. **Package fields.** Every package.json has the release version and a `repository` field pointing at
   `https://github.com/shaderera/shaderera`. The Claude Code plugin (`plugins/shaderera`) has no
   version on purpose: Claude Code then versions it by commit, so skill changes reach users
   without a release.
5. **Licences.** Re-run the dependency walk and update [licences.md](licences.md): every bundled
   or vendored dependency and every asset with its licence.
6. **Publish.** `npm publish --access public` for each tarball (core first, then `shaderera`,
   then `create-shaderera`), then tag `v<version>` and make a GitHub Release.
7. **Record.** Record the revision and each tarball's sha256 in the release notes.

**The public repository** starts at 0.1.0 from one commit of the cleaned tree, not from the
private repository's history ([ADR 0010](adr/0010-engine-licence-and-public-history.md)). From
0.1.1 everything is MIT ([ADR 0013](adr/0013-the-engine-is-mit.md)).
