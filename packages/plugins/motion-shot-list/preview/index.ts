// motion-shot-list: four shots of stand-in footage (23.976 fps as shot, 25 fps twice as fast, the
// first file again frozen at its end, 30 fps backwards), with a transition into the second and the
// fourth; close() marks where each file is last on screen. Top,
// what shotAt answers at t: the shot cut to last and the one leaving, each with its source frame
// and its progress, and the transition's progress. Bottom, the list as two lanes of bars scrolling
// past a fixed playhead, the overlaps where they share the screen. The list is 6 s long and repeats
// a loop either side, so the loop is seamless; the cut back to the first shot is the list's own.

import { createHouse, L, R, RED } from '../../previews/src/house.ts'
import { type OnScreen, type Shot, shotAt, shotList } from '../../previews/src/motion/shot-list.ts'
import { FONT, type OpenPreview } from '../../previews/src/preview.ts'

const SHOTS: (Shot & { note: string })[] = [
  {
    id: 'a',
    dur: 1.6,
    src: 'one.mp4',
    fps: '24000/1001',
    note: '23.976 fps footage, frames floored',
  },
  { id: 'b', dur: 1.8, transition: 0.4, src: 'two.mp4', fps: 25, speed: 2, note: 'twice as fast' },
  {
    id: 'c',
    dur: 1.4,
    src: 'one.mp4',
    fps: '24000/1001',
    in: 1,
    hold: 0.8,
    note: 'the same file again, frozen for its last 0.8 s',
  },
  {
    id: 'd',
    dur: 1.9,
    transition: 0.3,
    src: 'three.mp4',
    fps: 30,
    in: 2,
    speed: -1,
    note: 'backwards from 2 s',
  },
]

const PLAYHEAD = L + 360
const PX_PER_S = 230
const LANE = { top: 620, height: 58, gap: 26 }

const preview: OpenPreview = async (host, state) => {
  if (state !== 'default') throw new Error(`motion-shot-list has no state "${state}"`)
  const { width, height } = host.manifest
  const canvas = host.io.canvas(width, height)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const house = createHouse(host, ctx)
  const list = shotList(SHOTS)
  const loop = (t: number) => ((t % list.duration) + list.duration) % list.duration
  const sans = `"${FONT.sansLight}"`
  const mono = `"${FONT.mono}"`

  const label = (
    text: string,
    x: number,
    y: number,
    color = '#8a8a8a',
    align: CanvasTextAlign = 'left',
  ) => {
    ctx.font = `16px ${mono}`
    ctx.textAlign = align
    ctx.fillStyle = color
    ctx.fillText(text, x, y)
  }
  const bar = (x: number, y: number, w: number, p: number, color: string) => {
    ctx.fillStyle = '#2a2a2a'
    ctx.fillRect(x, y, w, 4)
    ctx.fillStyle = color
    ctx.fillRect(x, y, w * p, 4)
  }
  // One shot's readout: its id and rate, the source frame big, its progress.
  const readout = (on: OnScreen, x: number, role: string, color: string) => {
    const s = on.shot
    label(`${role}  ${s.id.toUpperCase()}  ${s.fps} FPS  ×${s.speed ?? 1}`, x, 200, color)
    ctx.font = `150px ${sans}`
    ctx.textAlign = 'left'
    ctx.fillStyle = color
    ctx.fillText(String(on.frame).padStart(3, '0'), x - 8, 340)
    label(`frame   source ${on.source.toFixed(3)} s`, x, 378)
    bar(x, 400, 400, on.progress, color)
    label(`local ${on.local.toFixed(2)} s   progress ${on.progress.toFixed(2)}`, x, 432)
  }

  return {
    async render(t, o) {
      const now = loop(t)
      const at = shotAt(list, now)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, width, height)
      ctx.textBaseline = 'alphabetic'
      house.index()
      const shot = at.shot.shot
      house.bigWord({
        text: `shot ${shot.id}`,
        corner: 'tl',
        since: at.shot.local,
        until: shot.end - now,
        frame: o.frame,
      })

      label('shotAt(list, t)', L, 150)
      readout(at.shot, L, 'SHOT', '#fff')
      if (at.leaving) readout(at.leaving, L + 500, 'LEAVING', '#7a7a7a')
      // The transition's progress: what a film would hand its dissolve, its dip or its flash.
      label('transition', L, 500)
      bar(L + 140, 494, R - L - 140, at.transition, '#fff')
      ctx.fillStyle = RED
      ctx.fillRect(L + 140 + (R - L - 140) * at.transition - 1, 484, 3, 24)
      label(at.transition.toFixed(2), R, 530, '#fff', 'right')

      // The list: even shots on one lane, odd on the other, so the overlaps show.
      ctx.save()
      ctx.beginPath()
      ctx.rect(L, 0, R - L, height)
      ctx.clip()
      for (const k of [-1, 0, 1])
        for (const s of list.shots) {
          const x0 = PLAYHEAD + (s.start + k * list.duration - t) * PX_PER_S
          const x1 = PLAYHEAD + (s.end + k * list.duration - t) * PX_PER_S
          if (x1 < L || x0 > R) continue
          const y = LANE.top + (s.index % 2) * (LANE.height + LANE.gap)
          const on = s === shot || s === at.leaving?.shot
          ctx.strokeStyle = on ? '#fff' : '#4a4a4a'
          ctx.lineWidth = 2
          ctx.strokeRect(x0 + 1, y + 1, x1 - x0 - 2, LANE.height - 2)
          // Its transition in: the span where the shot before is still on screen.
          if (s.transition) {
            ctx.fillStyle = on ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.08)'
            ctx.fillRect(x0, y, s.transition * PX_PER_S, LANE.height)
          }
          ctx.font = `20px ${mono}`
          ctx.textAlign = 'left'
          ctx.fillStyle = on ? '#fff' : '#6a6a6a'
          ctx.fillText(s.id.toUpperCase(), x0 + 12, y + 37)
          // Where its footage may be closed.
          if (s.end === list.closeAt[s.src ?? ''])
            label('close()', x1 - 8, y + 37, '#6a6a6a', 'right')
        }
      ctx.restore()
      ctx.fillStyle = RED
      ctx.fillRect(PLAYHEAD - 1, LANE.top - 10, 3, 2 * LANE.height + LANE.gap + 20)

      house.note(SHOTS[shot.index]?.note ?? '', R, 820)
      house.hud(t, o.frame, `${list.shots.length} SHOTS   ${list.duration.toFixed(1)} S`)
      return [{ color: canvas }]
    },
    status(t) {
      const at = shotAt(list, loop(t))
      return at.leaving
        ? `TRANSITION ${at.transition.toFixed(2)}`
        : `SHOT ${at.shot.shot.id.toUpperCase()}`
    },
    inspect(t) {
      const at = shotAt(list, loop(t))
      return {
        shot: at.shot.shot.id,
        frame: at.shot.frame ?? null,
        leaving: at.leaving?.shot.id ?? null,
        transition: at.transition,
      }
    },
  }
}

export default preview
