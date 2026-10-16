Any part of a large picture drawn at any size in Canvas2D, with the same pixels whatever was drawn before.

```ts
import { blit, pyramid } from './render/pyramid.ts'

// in open: the picture's halves, once (photo is a canvas, say a decoded 6000 × 4000 PNG)
const pic = pyramid(host.io, photo)                  // { levels, width, height }

// in render(t): drawImage's nine numbers, the source in the picture's own pixels
blit(ctx, pic, sx, sy, sw, sh, dx, dy, dw, dh)
```

Canvas2D's `'medium'` and `'high'` smoothing read mipmaps that Skia keeps in a cache large
pictures evict, so a big picture drawn small can come out a little different depending on what
the frames before it drew, and `shaderera check` fails. `pyramid` builds the picture's halves
down to a longest side of `min` px (1200), each drawn from the one above at exactly half size with
`'low'` smoothing (bilinear at half size averages 2×2). `blit` draws from the level that is at
most twice the size on screen, with `'low'` smoothing, so every draw is plain bilinear over
pixels that never change.

The picture is level 0, kept and not copied; the halves cost a third more memory again. `blit`
leaves the context's smoothing at `'low'`; transforms, alpha and composite apply as usual. It
does not decode images (`io.image`, or `render-image-textures`) and does not blur.
