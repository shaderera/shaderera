# Releasing

The repository went public at 0.1.0; 0.1.1 is the first release on npm. The three packages
(`@shaderera/core`, `shaderera`, `create-shaderera`) share one version. A release is checked as a
user gets it: from packed tarballs, installed with npm in a fresh folder outside the monorepo.

Since 0.1.5 a release also depends on shaderera.com: the site, its plugin library at
`shaderera.com/r`, its studio page, and the films API at `api.shaderera.com`. These live in the
site repository, shaderera/shaderera.com (private). The CLI talks to all of them, so the order
matters: the engine is fixed first, the site follows it, the site is deployed, and only then is the
CLI published. Follow the steps in order.

1. **A release commit R.** Merge the release's engine pull requests to `main`. R is the merge
   commit you release; every later step uses it. At R:
   - **Build and test.** `pnpm install`, `pnpm build`, `pnpm test:all`, `pnpm lint`.
   - **Package fields.** Every package.json has the release version and a `repository` field
     pointing at `https://github.com/shaderera/shaderera`. The Claude Code plugin
     (`plugins/shaderera`) has no version on purpose: Claude Code then versions it by commit, so
     skill changes reach users without a release.
   - **Licences.** Re-run the dependency walk and update [licences.md](licences.md): every bundled
     or vendored dependency and every asset with its licence.
2. **Pin the site to R, and merge the site.** In the site repository, in one pull request:
   - CI: set `SITE_ENGINE_COMMIT` in `.github/workflows/ci.yml` to R. CI builds the site's plugin
     library from the engine at that commit.
   - Contract: set `commit` in `apps/web/contract.source.json` to R, then copy the fixtures again
     with `node apps/web/scripts/contract.ts`. CI runs it with `--check`.
   - e2e: set the `@shaderera/core` and `shaderera` versions in `fixtures/*/package.json` to the
     release version, and the site's `VERSION` in `apps/site/src/content.ts`.

   Then merge the site's pull requests for the release on top of it, with CI green on each.
3. **Share the seed films.** Share MATTER and Logo Frames (`matter/` and `logo-frames/` in
   shaderera/films) to the films API with the CLI built at R, and check that each plays at the
   `https://shaderera.com/film/<id>` its share prints. Do this before any site change that empties
   the front page goes live, or the front page has no films. From each film's folder:
   ```bash
   node <shaderera at R>/apps/cli/bin/shaderera.js login
   node <shaderera at R>/apps/cli/bin/shaderera.js share
   ```
4. **Deploy the site.** Before the npm publish, and only with the owner's go-ahead: a deploy
   publishes every plugin merged at R, and a published name and version cannot be taken back. In
   the site repository, with a checkout of shaderera at R beside it (`../shaderera`):
   1. Rebuild `/r`: `cd apps/site && node tools/registry.mjs`. It writes `public/r/`.
   2. Diff the registry against live: compare `public/r/index.json` with
      `https://shaderera.com/r/index.json`, ignoring `published` (every rebuild resets it). Name
      every new plugin version to the owner. No script does this yet.
   3. Upload the changed previews: `node tools/previews.mjs`. It uploads each plugin's render in
      `packages/plugins/<name>/preview/out/` to R2, and skips one whose live `preview.json` names
      the same render.
   4. Deploy: `pnpm run deploy` (not `pnpm deploy`, a different pnpm command). It builds again and
      deploys the `shaderera-web` Worker, and with it the studio page. That page must speak the
      same studio relay protocol version as the CLI you are about to publish: a page and a CLI on
      different versions never pair.
   5. If the release changed the films API or the player, deploy them too:
      `cd apps/web && npx wrangler d1 migrations apply shaderera-app-dev --remote`, then
      `pnpm run deploy` in `apps/web` and in `apps/player`.
5. **Pack and publish.**
   ```bash
   pnpm --filter @shaderera/core --filter shaderera --filter create-shaderera \
     pack --pack-destination ../release
   ```
   Check that `create-shaderera`'s tarball holds `files/project/`, `files/AUTHORING.md`, the nine
   `files/guides/*.md`, `files/skills/shaderera/SKILL.md` and
   `files/skills/shaderera-plugins/SKILL.md`, and that `shaderera`'s holds `guides/` (nine files)
   and `docs/` (the reference, with `participants/` and `plugins.md`). Then, in a folder outside
   the monorepo:
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
   Every command must pass. The empty project needs WebGPU, so a GPU adapter. Then
   `npm publish --access public` for each tarball: core first, then `shaderera`, then
   `create-shaderera`.
6. **The clean-folder check.** In a new folder outside the monorepo, with the packages from npm:
   ```bash
   npx create-shaderera@<version> film
   cd film
   npx shaderera check
   npx shaderera render --host node
   npx shaderera render --host browser
   npx shaderera login
   npx shaderera share
   ```
   Open the film at the address `share` prints, and check that it plays on shaderera.com. Fork it
   with `npx shaderera fork <film id>`, and run `npx shaderera check` in the fork. Then run
   `npx shaderera studio` in the project and pair with the page twice: over loopback (Chrome, with
   local network access allowed), and over the relay (a browser that blocks local access, or
   Chrome with the prompt declined). Over the relay, export a file over 32 MiB from the page. Also
   check that `login` signs in, which needs the films API's GitHub client id to be the CLI's.
7. **Tag and record.** Tag R and push the tag:
   ```bash
   git tag v<version> <R>
   git push origin v<version>
   gh release create v<version> --repo shaderera/shaderera --title v<version> --notes-file <notes>
   ```
   The notes record R and each tarball's sha256 (`sha256sum ../release/*.tgz`). Then check that
   shaderera.com shows the new version.

**The public repository** starts at 0.1.0 from one commit of the cleaned tree, not from the
private repository's history ([ADR 0010](adr/0010-engine-licence-and-public-history.md)). From
0.1.1 everything is MIT ([ADR 0013](adr/0013-the-engine-is-mit.md)).
