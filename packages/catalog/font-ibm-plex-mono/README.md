IBM Plex Mono (OFL 1.1): Light, Regular and SemiBold, for data, code, captions and ASCII looks.

```ts
await host.io.font('assets/fonts/IBMPlexMono-SemiBold.ttf', 'IBM Plex Mono SemiBold')
await host.io.font('assets/fonts/IBMPlexMono-Regular.ttf', 'IBM Plex Mono')
ctx.font = '600 64px "IBM Plex Mono SemiBold"'
```

Keep `OFL-ibmplexmono.txt` with the fonts. "Plex" is a reserved font name: a modified font must
be renamed.
