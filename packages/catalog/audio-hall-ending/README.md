An ending that rings out in a hall and dies to silence, for a song that stops dead.

```sh
node tools/hall-ending.ts --in audio/song.mp3 --out audio/song-end.wav --send 43.95
# --send: just before the last chord or hit, in song seconds; --trim to start the film later
```

Then play `audio/song-end.wav` from the source's `audio()`, and measure that file (not the
original) so the picture is cut to what plays. Hold the picture still into the silence: the
silence is part of the ending.

Set `--wet` by ear. ffmpeg's `afir` normalises the hall to its peak, so the tail comes out far
under the song; 31 dB suited a loud electronic master. Needs ffmpeg and ffprobe on PATH.
