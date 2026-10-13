STIX Two Text (OFL 1.1): a scientific serif, roman and italic, for notes and annotation beside a monospace.

```ts
await host.io.font('assets/fonts/STIXTwoText-Italic[wght].ttf', 'STIX Two Text Italic')
ctx.font = '30px "STIX Two Text Italic"'
```

Both files are variable (weight 400 to 700), and `io.font` registers their default instance,
Regular: a weight in `ctx.font` does not move the axis on every host. For another weight, cut a
static instance once (`fonttools varLib.instancer "STIXTwoText[wght].ttf" wght=600 -o
STIXTwoText-SemiBold.ttf`) and register it as its own family.

Keep `OFL-stixtwotext.txt` with the fonts.
