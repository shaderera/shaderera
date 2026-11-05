// The preview's Lottie file, made in code as its JSON text: 6 s at 30 fps, a card on a null that
// travels a curved path out and back, scales with each axis on its own curve (y overshooting),
// turns with a hold in the middle, and fades in from an older file's `e` keys. A shape layer with
// an expression is there so the reader has something to list as unsupported.

const ease = (ox: number, oy: number, ix: number, iy: number) => ({
  o: { x: [ox], y: [oy] },
  i: { x: [ix], y: [iy] },
})

export const makeLottie = () =>
  JSON.stringify({
    v: '5.12.1',
    nm: 'motion-lottie-read preview',
    fr: 30,
    ip: 0,
    op: 180,
    w: 900,
    h: 420,
    ddd: 0,
    layers: [
      {
        ind: 1,
        ty: 3,
        nm: 'Card',
        ip: 0,
        op: 180,
        st: 0,
        sr: 1,
        ks: {
          a: { a: 0, k: [0, 0, 0] },
          p: {
            a: 1,
            k: [
              {
                t: 0,
                s: [140, 300, 0],
                to: [120, -260, 0],
                ti: [-160, 40, 0],
                ...ease(0.33, 0, 0.67, 1),
              },
              {
                t: 60,
                s: [560, 120, 0],
                to: [180, 0, 0],
                ti: [60, -160, 0],
                ...ease(0.7, 0, 0.2, 1),
              },
              {
                t: 120,
                s: [760, 320, 0],
                to: [-200, 140, 0],
                ti: [200, 60, 0],
                ...ease(0.4, 0, 0.1, 1),
              },
              { t: 180, s: [140, 300, 0] },
            ],
          },
          s: {
            a: 1,
            k: [
              {
                t: 0,
                s: [100, 100, 100],
                o: { x: [0.3, 0.6], y: [0, 0] },
                i: { x: [0.7, 0.2], y: [1, 1.6] },
              },
              { t: 75, s: [160, 60, 100], ...ease(0.5, 0, 0.5, 1) },
              { t: 180, s: [100, 100, 100] },
            ],
          },
          r: {
            a: 1,
            k: [
              { t: 0, s: [0], ...ease(0.8, 0, 0.2, 1) },
              { t: 50, s: [135], h: 1 },
              { t: 100, s: [135], ...ease(0.1, 0.9, 0.3, 1) },
              { t: 180, s: [360] },
            ],
          },
          o: {
            a: 1,
            k: [
              { t: 0, s: [15], e: [100], ...ease(0.2, 0, 0.4, 1) },
              { t: 30, s: [100], e: [100], ...ease(0.3, 0, 0.7, 1) },
              { t: 150, s: [100], e: [15], ...ease(0.6, 0, 0.8, 1) },
              { t: 180 },
            ],
          },
        },
      },
      {
        ind: 2,
        ty: 4,
        nm: 'Ring',
        parent: 1,
        ip: 0,
        op: 180,
        st: 0,
        ks: { o: { a: 0, k: 100, x: 'wiggle(2, 10)' } },
        shapes: [{ ty: 'el', nm: 'Ellipse' }],
      },
    ],
  })
