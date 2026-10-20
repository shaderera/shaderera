# 0021: The studio is a page on shaderera.com that drives the local CLI

2026-10-20. The owner decided. This lifts the hold on the Studio (2026-10-10).

**Context.** The owner wants the CLI to be part of how people actually make films, not a tool they have to learn on their own. Someone installs Shaderera, asks their agent for a video, and gets a studio page in the browser, as HyperFrames Studio does. That page lives at `https://shaderera.com/studio/<id>`.

The project, its code and its renders stay on the person's machine until they share the film. shaderera.com still learns how the studio is used.

Two products already work this way:
- **Drizzle Studio:** its UI is hosted at `local.drizzle.studio` and talks to `drizzle-kit studio` on 127.0.0.1:4983.
- **LangGraph Studio:** its UI is at `smith.langchain.com/studio/?baseUrl=…` and talks to the local `langgraph dev`, with a `--tunnel` fallback.

Both report the same limit: Safari and Brave block a public page from calling localhost. From Chrome 142, Chrome asks the person once for permission ("Local Network Access").

A spike on workers.dev measured this in Chrome 155 and Edge 155. Pairing went through a relay, and the page then talked to 127.0.0.1 directly. A 1 MB frame took 4–5 ms directly and 225–376 ms through the relay, and a relay round trip took 74–89 ms. A fetch declared `targetAddressSpace: "local"` fails for 127.0.0.1. It must be left undeclared or declared `"loopback"`. Safari, Firefox and Brave were not tested.

**Decision.**

1. **The studio is a page on shaderera.com.** Its UI ships with the site, so it can change without a CLI release. The CLI serves no UI.
2. **The CLI is the person's local bridge.** `shaderera studio` listens on 127.0.0.1 only, for as long as the command runs. It reads and writes the project, watches it for the agent's edits, previews, renders, exports and shares, all through the hosts this repo already has. The CLI is not installed as a service.
3. **There are two ways in, and both end in one studio session:**
   - **From the CLI.** `shaderera studio` makes the id and opens the page.
   - **From the web.** `shaderera.com/studio` makes the id and shows a prompt to copy for the agent: `npx shaderera@latest studio --connect <id>`. The same command installs Shaderera if needed and connects either way.
4. **Pairing goes through a relay on shaderera.com; the work goes directly.**
   - A studio session's id is used once and expires if no CLI connects within minutes.
   - The CLI and the page meet on the relay only to exchange the CLI's port and a secret. The secret is exchanged end to end, so the relay never learns it.
   - After pairing, the page talks to 127.0.0.1 directly. The bridge accepts only shaderera.com's origin carrying that session's secret.
   - Another browser that opens the same link sees nothing.
5. **The fallback is the relay.** Where a browser refuses loopback (Safari and Brave, and Chrome if the person declines the prompt), the session runs through the relay instead. The page says so. The relay forwards and stores nothing.
6. **Code reaches shaderera.com only when the person shares.** The studio's share button runs `shaderera share` (0019, 0020). Shared films are listed on the site automatically.
7. **Telemetry without code.** shaderera.com records studio events only:
   - opened, paired (with the CLI version and OS), edits counted, renders and exports (format, length, time taken), shares and errors;
   - never source, file names, params or frames.
   
   The counts are stored with PostHog through the site's Worker, with no client SDK and no cookies.

   The CLI says so the first time it runs, and `SHADERERA_TELEMETRY=0` (or a config flag) turns it off.

**Consequences.**
- The Studio is no longer on hold. The old UI, `shaderera dev` and the agent broker on branch `studio` (8ff9e1e) are a starting point, not the design: their UI moves to the site, and the CLI keeps only the bridge.
- **The site gains** `/studio`, `/studio/<id>` and a relay (a Durable Object per studio session).
- **The CLI gains** `shaderera studio [--connect <id>]`, the bridge and the telemetry notice.
- **To test:** Safari, Firefox and Brave, before the relay fallback is called done.
- **Out of scope:** publishing from CI (a GitHub Action that shares films on merge). Shares come from the studio or the CLI.
