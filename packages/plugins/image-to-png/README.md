WebP, AVIF, GIF and a video's frames converted to PNG once, beside the originals, so every host decodes them the same.

```sh
node tools/to-png.ts assets/*.webp                 # once: WebP → PNG beside each (colours kept)
node tools/to-png.ts --frames 12 assets/clip.webm  # a clip's frames as PNGs, 12 a second
```

A film then reads the PNGs with core's `io.image`, which decodes only PNG and JPEG, in JavaScript,
the same pixels in Node and the browser. Pixels are kept as they are: no resizing, no colour
change. Needs ffmpeg on the PATH.
