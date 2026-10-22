# Releasing

The repository went public at 0.1.0; 0.1.1 is the first release on npm. The three packages
(`@shaderera/core`, `shaderera`, `create-shaderera`) share one version. A release is checked as a
user gets it: from packed tarballs, installed with npm in a fresh folder outside the monorepo.

Since 0.1.5 a release also depends on shaderera.com: the site, its plugin library at
`shaderera.com/r`, its studio page, and the films API at `api.shaderera.com`. The CLI talks to all
of them, so the order matters: the engine is fixed first, the site follows it and is deployed, the
CLI is published, and only then does the site say the new version. Follow the steps in order.
The site's commands for steps 2, 3, 4 and 6 are in the shaderera.com repository's README, under
"Release".

1. **A release commit R.** Merge the release's engine pull requests to `main`. R is the merge
   commit you release; every later step uses it. At R:
   - **Build and test.** `pnpm install`, `pnpm build`, `pnpm test:all`, `pnpm lint`.
   - **Package fields.** Every package.json has the release version and a `repository` field
     pointing at `https://github.com/shaderera/shaderera`. The Claude Code plugin
     (`plugins/shaderera`) has no version on purpose: Claude Code then versions it by commit, so
     skill changes reach users without a release.
   - **Licences.** Re-run the dependency walk and update [licences.md](licences.md): every bundled
     or vendored dependency and every asset with its licence.
2. **Pin the site to R, and merge the site.** Point the site's CI at R, both the engine it builds
   the plugin library from and the films API's contract fixtures it checks against. Then merge the
   site's pull requests for the release. Leave the site's version and its e2e fixtures' versions
   alone until step 6: npm does not have the release yet.
3. **Share the seed films.** Share MATTER and Logo Frames (from shaderera/films) to the films API
   with the CLI built at R (`login`, then `share` from each film's folder), and check that each
   plays at the `https://shaderera.com/film/<id>` its share prints.
   Do this before any site change that empties the front page goes live, or the front page has no
   films.
4. **Deploy the site.** Before the npm publish, and only with the owner's go-ahead: a deploy
   publishes every plugin merged at R, and a published name and version cannot be taken back.
   1. Rebuild the plugin library (`/r`) from R.
   2. Compare the rebuilt library's index with the live `https://shaderera.com/r/index.json`,
      ignoring `published` (every rebuild resets it). Name every new plugin version to the owner.
      No script does this yet.
   3. Upload the previews of the plugins whose render changed.
   4. Deploy the site, and with it the studio page. That page must speak the same studio relay
      protocol version as the CLI you are about to publish: a page and a CLI on different
      versions never pair.
   5. If the release changed the films API or the player, apply the API's database migrations and
      deploy both.
5. **Pack and publish.**
   ```bash
   pnpm --filter @shaderera/core --filter shaderera --filter create-shaderera \
     pack --pack-destination ../release
   ```
   Check that `create-shaderera`'s tarball holds `files/project/`, `files/AUTHORING.md`, the nine
   `files/guides/*.md`, and that `shaderera`'s holds `guides/` (nine files) and `docs/` (the
   reference, with `participants/` and `plugins.md`). A new project holds no skills: they are
   installed once, with the Claude Code plugin or `npx skills add`. Then, in a folder outside
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
6. **The site says the version.** Now that npm has it, set the site's version and its e2e
   fixtures' `@shaderera/core` and `shaderera` versions to the release, merge that, and deploy the
   site again. The plugin library is the same as step 4's, so its diff is empty.
7. **The clean-folder check.** In a new folder outside the monorepo, with the packages from npm:
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
   check that `login` signs in, which needs the films API's GitHub client id to be the CLI's, and
   that an HDR10 film shared to the site plays in the web player.
8. **Tag and record.** Tag R and push the tag:
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
