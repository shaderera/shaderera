# Install Shaderera with your agent

Copy the prompt below into your coding agent. It checks that Node.js 24 or newer and ffmpeg are
installed, installs the Shaderera skills, starts a film project and gives the agent its MCP
server. It installs only what is missing, and only with tools your machine already has.

It works in any agent that can run a terminal command:

| Agent | Get it |
|---|---|
| Claude Code | https://claude.com/claude-code |
| Codex | https://developers.openai.com/codex |
| Cursor | https://cursor.com |
| Gemini CLI | https://github.com/google-gemini/gemini-cli |
| OpenCode | https://opencode.ai |

```text
Goal:
Make sure Node.js 24 or newer and ffmpeg are installed, install the Shaderera skills, and start
a Shaderera film project.

Check first:
Run `node --version` and `ffmpeg -version`.
If Node.js is installed and its major version is 24 or higher, do not install or change Node.js.
If ffmpeg runs, do not install or change ffmpeg.

Install policy:
Install only what is missing.
Use a package manager only if it is already installed.
Do not install Homebrew, winget, Chocolatey, Scoop, nvm, fnm or another package manager just for
this task.
Ask the person before anything that needs administrator rights.

If Node.js is missing or older than v24:
- macOS: use Homebrew if it is installed; otherwise the official Node.js `.pkg` installer.
- Windows: use winget if it is installed; otherwise the official Node.js `.msi` installer.
- Linux: use the system package manager if it offers Node.js 24 or newer. On Debian/Ubuntu or
  RHEL/Fedora-compatible systems, use the official NodeSource instructions for Node.js 24 or
  newer. Otherwise use the official standalone Linux binary for this architecture.
Download Node.js installers and binaries from https://nodejs.org/download/release/latest/

If ffmpeg is missing:
- macOS: `brew install ffmpeg` if Homebrew is installed; otherwise a static build linked from
  https://ffmpeg.org/download.html
- Windows: `winget install --id Gyan.FFmpeg` if winget is installed; otherwise a release build
  linked from https://ffmpeg.org/download.html, with its `bin` folder added to PATH.
- Linux: the system package manager (for example `sudo apt install ffmpeg`); otherwise a static
  build linked from https://ffmpeg.org/download.html
Chrome is needed only for films drawn as a web page (the browser host). Do not install it now.

Verify:
Run `node --version` and `ffmpeg -version` again. Continue only if Node.js is 24 or higher and
ffmpeg runs. Open a new terminal first if PATH changed.

Install the skills:
- In Claude Code: run `claude plugin marketplace add shaderera/shaderera`, then
  `claude plugin install shaderera@shaderera`. Tell the person to run `/reload-plugins`.
- In any other agent: run `npx skills add shaderera/shaderera -g -y`.

Start a film project:
Ask the person where the project should go and what to call it. The default is a folder named
`my-film` in the current directory. Then run, in order:
  npx create-shaderera@latest <name>
  cd <name>
  npm install
  npx shaderera doctor
  npx shaderera check
`doctor` must not report anything an mp4 render needs as missing, and `check` must pass.

Give yourself eyes:
Add a stdio MCP server named `shaderera` that runs `npx shaderera mcp` in the project folder,
the way your agent adds MCP servers. In Claude Code, from the project folder:
`claude mcp add shaderera -- npx shaderera mcp`

Success message:
Tell the person they are set up, where the project is, and what to do next:
Start a new thread in the project folder, then describe the film in your own words: what it is
for, its format and length, the words on screen, the music, and any brand files. For example:
"Make a 15-second 9:16 teaser for our running shoe: the shoe turns once on a dark set, the line
'Built for the last mile' lands on the beat, and the logo holds for the last 2 seconds. Run
check, show me a contact sheet, then render."
```

The prompt never installs a package manager, never changes a Node.js or ffmpeg that already
works, and asks before anything that needs administrator rights. To install by hand instead, see
the [Quick start](README.md#quick-start).
