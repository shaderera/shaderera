The film's own source as a scrolling, glitching wall of text, with a claim cut out of the middle: "everything is source code".

```ts
import { createCodeWall, readCode } from './type/code-wall.ts'

// in open
const wall = createCodeWall({
  files: await readCode(host, ['src/composition.ts', 'src/scene.wgsl']),
  start: clock.at(31),
  end: clock.at(32, 2),
  step: clock.sixteenth,
  claim: ['EVERYTHING', 'IS SOURCE CODE'],
  fonts: { mono: '"IBM Plex Mono"', claim: '"IBM Plex Mono SemiBold"' },
})

// in render(t), on a Canvas2D layer
wall(ctx, W, H, t, options.frame)
```

A wide frame shows the files side by side; a tall one shows one file at a time, changing on
each step. Built on `text-scramble`, which `add` copies in with it.
