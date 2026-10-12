A clock slate for a broadcast preroll: the spot's details and a countdown, drawn by the film at
negative t when its variant declares `preroll: { seconds, fill: 'source' }`.

```ts
import { drawSlate } from './delivery/slate.ts'

// shaderera.json: "variants": { "tv": { "preroll": { "seconds": 10, "fill": "source" }, "timecode": "10:00:00:00" } }
render: async (t) => {
  const ctx = canvas.getContext('2d')
  if (drawSlate(ctx, t, { width, height, family: 'IBM Plex Sans', fields: {
    Title: 'Spring sale', Client: '…', Agency: '…', Duration: '30"', Clock: 'ABC/DEFG123/030',
  } })) return { color: canvas }
  // t >= 0: the film
}
```

It shows exactly the fields given, in order, and the whole seconds left; the last `blackFor`
seconds (2 by default) are black. Which fields a broadcaster asks for, the preroll's length and
how long it stays black come from that broadcaster's spec (UK clock numbers from Clearcast); check
it before a delivery. A plain layout, yours to change once copied.
