# Your first 10 minutes

For a person starting with Shaderera. A Shaderera film is code: your AI agent writes it, and you
watch it and say what to change in the studio, a page on shaderera.com. The film and its code
stay on your computer until you share it.

You need a computer with Node.js 24 or newer, ffmpeg, and an AI agent that can run commands in a
terminal: Claude Code, Codex, Cursor, Gemini CLI, OpenCode or another. If Node.js or ffmpeg is
missing, the agent tells you and can install it.

## 1. Install

**In Claude Code**, install the Shaderera plugin. In a terminal:

```bash
claude plugin marketplace add shaderera/shaderera
claude plugin install shaderera@shaderera
```

Then type `/reload-plugins` in Claude Code.

**In another agent**, add the Shaderera skills. In a terminal, in the folder you work in:

```bash
npx skills add shaderera/shaderera
```

**Or** copy the install prompt (`INSTALL.md` in the
[Shaderera repository](https://github.com/shaderera/shaderera/blob/main/INSTALL.md)) into your
agent. It checks Node.js and ffmpeg, installs the skills and starts a film project for you.

## 2. Ask for a film in your own words

Open your agent in the folder where the film should live and say what you want: what the film
is for, its length and shape (wide, tall, square), the words on screen, the music, and any brand
files such as a logo or fonts. Put those files in the folder, or tell the agent where they are.

The agent starts a project, writes the film, and checks that each frame comes out the same every
time it is drawn. It asks when something only you can give is missing, such as a product's
photos.

## 3. The studio opens: watch, comment, export

When the first draft passes its check, the agent opens the studio in your browser and gives you
its address. Keep that address to yourself: it is the key to your computer's side of the studio.

- **The first time**, Chrome asks to let shaderera.com "access other apps and services on this
  device". Allow it: that is how the page reaches the film on your computer. If you say no, you
  can still comment, export and share, but the film does not play.
- **Watch.** The film plays in the page. When the agent edits it, the film keeps playing and the
  new version takes over once it is ready.
- **Comment.** Pause where something should change, press **Comment**, click a point or drag a
  box on the frame if the change is in one place, and write what should change. Your agent reads
  the comment, works on it and marks it fixed. Each comment's card says where it is: sent, read,
  being worked on, or fixed.
- **Check a fix.** On a fixed comment, press **See the fix** to see before and after. Press
  **Yes, close it** if it is right, or **Not yet** and say what is still wrong.
- **Export.** Pick a format (an mp4 video, a ProRes mov, or a png of the frame on screen) and
  press **Export**. Your computer renders it and the page saves the file.

[Using the studio](using-the-studio.md) has every control and key.

## 4. Share

Press **Share…** in the studio, or ask your agent to share the film. It goes to shaderera.com as
a film page with its code, which anyone with the link can watch.

- The first time, you sign in with GitHub: the studio or the agent shows you the one command to
  run.
- A new film is "all rights reserved". Your agent asks which licence you want before it shares,
  for example MIT, which lets others fork and reuse it.
- Sharing sends the project's files, never your renders or what the agent keeps on your computer.
  Ask the agent to list what would be sent first.

Sharing again sends a new version of the same film.

## When something is wrong

Tell your agent what you see, in your words. It can check your computer (Node.js, ffmpeg, the
GPU) and say what is missing and how to fix it.
