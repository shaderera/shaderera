IBM Plex Sans (OFL 1.1): Light, Regular and Medium, for names, dates, labels and captions, in Latin, Greek and Cyrillic.

```ts
await host.io.font('assets/fonts/IBMPlexSans-Regular.ttf', 'IBM Plex Sans')
await host.io.font('assets/fonts/IBMPlexSans-Medium.ttf', 'IBM Plex Sans Medium')
ctx.font = '36px "IBM Plex Sans"'
```

"Plex" is a reserved font name: a modified font must be renamed. Keep `IBMPlexSans-OFL.txt` with
the fonts.
