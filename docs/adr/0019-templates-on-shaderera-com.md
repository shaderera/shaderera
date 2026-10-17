# 0019: Templates on shaderera.com, and one CLI to fork

2026-10-18. Owner accepted.

**Context.** [0011](0011-experts-and-agents-no-taste-lock.md) made Shaderera for experts and their
agents. It has no beginner path, no starter films and no template type. Every project starts
empty.

The shaderera.com app proof of concept (POC), in the private repo `shaderera/shaderera.com`, then
showed what a published film can do in a viewer's browser:
- it plays on the viewer's own GPU;
- it exposes its declared params as controls;
- it takes the viewer's own clip in a `format: video` param, which never leaves the machine;
- it exports an mp4 made on that machine.

No credits are spent and nothing renders in the cloud.

Research for the site found that beginners customise what a creator exposes (CapCut slots,
MOGRT controls). They do not start from code. Among creative tools, only those whose templates
*are* the source (Shadertoy, Spline, Rive) let a template prove what the tool can do from
scratch. Higgsfield shows the prompts behind a project. A Shaderera film is its code, so it can
show that.

The owner decided that the engine stays for experts, and that shaderera.com serves beginners
through templates.

**Decision.**

1. **0011 stands for the engine.** `create-shaderera` still makes an empty project. There are no
   starter films, no template plugin type and no default look in core or the plugins. The engine's
   docs, README and agent notes stay written for experts and their agents.
2. **A template is a published film that someone else may customise.** It is listed on
   shaderera.com, in the browser only.
   - Its author made it and owns its taste. Shaderera adds no look to it.
   - What a viewer may change is what the film declares: its `params`, including media slots
     such as `format: video`.
   - The viewer changes them in the browser and exports there. Nothing they add is uploaded.
3. **Every template shows its source.** The film page links to the code of the published version,
   and to the command that forks it. To be listed as a template, a film must:
   - play live in the browser;
   - publish its source;
   - name the licence of every outside file (as [0017](0017-outside-media.md) records it);
   - declare at least one param.

   Shaderera's own team picks the templates until there is moderation for anyone else's.
4. **One CLI, the open-source one.** Forking a film and sending one to shaderera.com are commands
   of `shaderera`, as [0014](0014-plugins-in-one-cli.md) keeps everything in one CLI.
   - The app's own POC CLI (`shaderera-app`) is retired once they exist.
   - `shaderera fork <film>` copies a published version into a new folder, as an ordinary
     project. It is the only way from a template to a project.
   - Sending a film is a separate command. `publish` already means a plugin, so the film's verb
     is named when it is built.
   - Both run only when called, and send only the project's files.
   - The default host is shaderera.com, and a person may name another.
5. **The site says what it is.** Its FAQ and copy describe the two ways in:
   - a template, customised in the browser;
   - a project from scratch, written by a person or their agent with the open-source engine.

   Both make the same kind of film.

**Consequences.**
- The site's FAQ line "there is no beginner path and no templates" is replaced.
- The engine gains `shaderera fork` and a film-sending command, moved from the app's POC.
- The app's API becomes something the engine depends on, so its routes are versioned before the
  commands ship.
- The glossary gains **Template**. A **project** is still never called a template.
- Nothing in a new project changes.
