// review-picture-reuse: a 6 s film made in code (preview/make.ts), eight shots of four pictures,
// some coming back cropped, cut by review-shots and compared by the plugin's own
// tools/review-picture-reuse.py. The film plays in its panel; under it the shots lie on a
// timeline, each as its frame from review-shots' contact sheet, and arcs join the shots the tool
// found to show one picture. The shot playing and its picture's arcs are lit, and the summary
// stands beside the film.

import { createHouse, frameLabel, L, R, RED } from '../../previews/src/house.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const FILM = 'audio/review-picture-reuse.mp4'
const DIR = 'audio/review-picture-reuse'
/** review-shots' sheet: 6 columns of 320 px frames, each with a 22 px label under it. */
const SHEET = { columns: 6, width: 320, label: 22 }
const PANEL = { x: L, y: 176, width: 620 }
const STRIP = { top: 640, height: 80 }

type Shot = { id: string; start: number; end: number }
type Reuse = {
  summary: {
    shots: number
    pictures: number
    repeatShare: number
    adjacentRepeats: number
    returns: number
    returnGapMedian: number | null
    maxUses: number
  }
  groups: { id: string; shots: { id: string; start: number }[] }[]
}

const reviewPictureReuse: OpenPreview = async (host, stateId) => {
  if (stateId !== 'default') throw new Error(`review-picture-reuse has no state "${stateId}"`)
  const { width, height, duration } = host.manifest
  const frames = Math.round(duration * Number(host.manifest.fps))
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const mono = `"${FONT.mono}"`
  const monoBold = `"${FONT.monoBold}"`

  // The tools' output, as they wrote it.
  const read = async <T>(path: string) =>
    JSON.parse(new TextDecoder().decode(await host.io.read(`${DIR}/${path}`))) as T
  const { shots } = await read<{ shots: Shot[] }>('shots.json')
  const { summary, groups } = await read<Reuse>('picture-reuse.json')
  if (!host.io.image || !host.io.video)
    throw new Error('The review-picture-reuse preview needs io.image and io.video')
  const img = await host.io.image(`${DIR}/sheet-1.jpg`)
  const sheet = host.io.canvas(img.width, img.height)
  const sctx = sheet.getContext('2d') as OffscreenCanvasRenderingContext2D
  const data = sctx.createImageData(img.width, img.height)
  data.data.set(img.data)
  sctx.putImageData(data, 0, 0)

  const film = await host.io.video(FILM)
  const fc = host.io.canvas(film.width, film.height)
  const fctx = fc.getContext('2d') as OffscreenCanvasRenderingContext2D
  const fimg = fctx.createImageData(film.width, film.height)
  const panelHeight = (PANEL.width * film.height) / film.width
  const thumbHeight = Math.round((SHEET.width * film.height) / film.width)

  // Each shot's picture: its group (null when shown once), which use it is, and what that use is.
  const uses = shots.map((s, k) => {
    const group = groups.find((g) => g.shots.some((u) => u.id === s.id)) ?? null
    const n = group ? group.shots.findIndex((u) => u.id === s.id) : 0
    const last = group && n > 0 ? shots.findIndex((u) => u.id === group.shots[n - 1]?.id) : -1
    const kind = n === 0 ? 'new' : last === k - 1 ? 'cut-in' : 'return'
    return { group, n, kind, first: group?.shots[0]?.start ?? s.start }
  })
  const shotAt = (t: number) => {
    const i = Math.max(
      0,
      shots.findLastIndex((s) => t >= s.start),
    )
    const s = shots[i] as Shot
    return { i, s, use: uses[i] as (typeof uses)[number], since: t - s.start, until: s.end - t }
  }
  const xOf = (time: number) => L + (time / duration) * (R - L)
  const centreOf = (id: string) => {
    const s = shots.find((u) => u.id === id) as Shot
    return (xOf(s.start) + xOf(s.end)) / 2
  }

  const drawFilm = async (t: number, frame: number) => {
    const i = Math.min(film.frames - 1, Math.round(t * film.fps))
    fimg.data.set(await film.frame(i))
    fctx.putImageData(fimg, 0, 0)
    ctx.drawImage(fc, PANEL.x, PANEL.y, PANEL.width, panelHeight)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1
    ctx.strokeRect(PANEL.x - 0.5, PANEL.y - 0.5, PANEL.width + 1, panelHeight + 1)
    ctx.font = `13px ${mono}`
    ctx.fillStyle = '#8a8a8a'
    ctx.textAlign = 'left'
    ctx.fillText('review-picture-reuse.mp4', PANEL.x, PANEL.y - 10)
    ctx.textAlign = 'right'
    ctx.fillText(frameLabel(frame, frames), PANEL.x + PANEL.width, PANEL.y - 10)
  }

  // The summary, as picture-reuse.json has it, and the shot playing.
  const drawNumbers = (i: number) => {
    const x = PANEL.x + PANEL.width + 32
    const use = uses[i] as (typeof uses)[number]
    const rows: [string, string][] = [
      ['SHOT', `${i + 1} / ${summary.shots}`],
      ['PICTURE', use.group ? use.group.id.toUpperCase() : 'ONCE'],
      ['USE', use.group ? `${use.n + 1} / ${use.group.shots.length}` : '1 / 1'],
      ['PICTURES', String(summary.pictures)],
      ['REPEAT', `${Math.round(summary.repeatShare * 100)} %`],
      ['RETURNS', String(summary.returns)],
      ['CUT-INS', String(summary.adjacentRepeats)],
      ['GAP', summary.returnGapMedian === null ? '—' : `${summary.returnGapMedian.toFixed(2)} S`],
      ['MAX USES', String(summary.maxUses)],
    ]
    ctx.textAlign = 'left'
    rows.forEach(([k, v], j) => {
      const y = PANEL.y + 14 + j * 38
      ctx.font = `13px ${mono}`
      ctx.fillStyle = '#7a7a7a'
      ctx.fillText(k, x, y)
      ctx.font = `17px ${j === 1 ? monoBold : mono}`
      ctx.fillStyle = j === 1 && use.group ? RED : '#fff'
      ctx.fillText(v, x + 104, y)
    })
  }

  // The shots on the film's timeline, each as its sheet frame, and an arc from each use of a
  // picture to its next; the playing picture's arcs in red.
  const drawStrip = (t: number, cur: number) => {
    const lit = uses[cur]?.group
    for (const g of groups)
      g.shots.slice(1).forEach((u, n) => {
        const a = centreOf(g.shots[n]?.id as string)
        const b = centreOf(u.id)
        const rise = Math.min(90, 24 + (b - a) * 0.22)
        ctx.strokeStyle = g === lit ? RED : '#4a4a4a'
        ctx.lineWidth = g === lit ? 3 : 2
        ctx.beginPath()
        ctx.moveTo(a, STRIP.top - 8)
        ctx.bezierCurveTo(a, STRIP.top - 8 - rise, b, STRIP.top - 8 - rise, b, STRIP.top - 8)
        ctx.stroke()
      })
    shots.forEach((s, k) => {
      const use = uses[k] as (typeof uses)[number]
      const x0 = xOf(s.start) + 1
      const w = xOf(s.end) - 1 - x0
      const sh = Math.min(thumbHeight, (SHEET.width * STRIP.height) / w)
      const sx = (k % SHEET.columns) * SHEET.width
      const sy = Math.floor(k / SHEET.columns) * (thumbHeight + SHEET.label)
      ctx.globalAlpha = k === cur ? 1 : 0.35
      ctx.drawImage(
        sheet,
        sx,
        sy + (thumbHeight - sh) / 2,
        SHEET.width,
        sh,
        x0,
        STRIP.top,
        w,
        STRIP.height,
      )
      ctx.globalAlpha = 1
      ctx.textAlign = 'left'
      ctx.fillStyle = k === cur ? '#fff' : '#6a6a6a'
      ctx.font = `14px ${k === cur ? monoBold : mono}`
      ctx.fillText(
        use.group ? use.group.id.replace('picture-', 'P') : '—',
        x0 + 4,
        STRIP.top + STRIP.height + 22,
      )
      ctx.font = `12px ${mono}`
      ctx.fillText(use.kind.toUpperCase(), x0 + 4, STRIP.top + STRIP.height + 40)
    })
    ctx.fillStyle = '#fff'
    ctx.fillRect(Math.round(xOf(t)) - 1, STRIP.top - 6, 3, STRIP.height + 12)
  }

  const headline = (use: (typeof uses)[number]) =>
    use.kind === 'new' ? 'new picture' : use.kind === 'cut-in' ? 'cut in' : 'seen before'

  return {
    async render(t, o) {
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      house.index()
      await drawFilm(t, o.frame)
      const cur = shotAt(t)
      drawNumbers(cur.i)
      drawStrip(t, cur.i)
      house.bigWord({
        text: headline(cur.use),
        corner: 'tl',
        maxWidth: 700,
        since: cur.since,
        until: cur.until,
        frame: o.frame,
      })
      house.bigWord({
        text: cur.use.group ? cur.use.group.id : 'shown once',
        corner: 'br',
        since: cur.since - 0.06,
        until: cur.until,
        frame: o.frame + 3,
      })
      house.note(
        cur.use.kind === 'new'
          ? 'a picture not shown before'
          : `the picture first shown at ${cur.use.first.toFixed(2)} s, cropped`,
      )
      house.hud(
        t,
        o.frame,
        `${summary.shots} SHOTS   ${summary.pictures} PICTURES   ORB + RANSAC HOMOGRAPHY`,
        'tools/review-picture-reuse.py',
      )
      return [{ color: canvas }]
    },
    status(t) {
      const { s, use } = shotAt(t)
      return `${s.id}  ${use.group?.id ?? 'once'}  ${use.kind}`
    },
    inspect(t) {
      const { s, use } = shotAt(t)
      return { id: 'picture-reuse', shot: s.id, picture: use.group?.id ?? null, use: use.kind }
    },
  }
}

export default reviewPictureReuse
