import type { Caption } from './protocol.ts'

/**
 * The captions inside the window [from, to], cut to it and shifted so the window starts at 0,
 * in order of start. A caption that is not a finite span with text is refused, naming it.
 */
export const windowCaptions = (
  captions: readonly Caption[],
  from: number,
  to: number,
): Caption[] => {
  for (const [i, c] of captions.entries())
    if (
      !Number.isFinite(c.start) ||
      !Number.isFinite(c.end) ||
      !(c.end > c.start) ||
      typeof c.text !== 'string'
    )
      throw new Error(
        `Caption ${i} needs a start before its end, in seconds, and text: ${JSON.stringify(c)}.`,
      )
  return captions
    .filter((c) => c.end > from && c.start < to && c.text.trim() !== '')
    .map((c) => ({
      start: Math.max(c.start, from) - from,
      end: Math.min(c.end, to) - from,
      text: c.text,
    }))
    .sort((a, b) => a.start - b.start)
}

/** Seconds as `HH:MM:SS<sep>mmm`, rounded to the millisecond. */
const clock = (seconds: number, sep: string) => {
  const ms = Math.round(seconds * 1000)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`
}

/** Blank lines end a cue in both formats: they become single line breaks. */
const lines = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()

/** Captions as SubRip (SRT). */
export const toSrt = (captions: readonly Caption[]): string =>
  captions
    .map((c, i) => `${i + 1}\n${clock(c.start, ',')} --> ${clock(c.end, ',')}\n${lines(c.text)}\n`)
    .join('\n')

/** Captions as WebVTT, with `-->`, `&` and `<` escaped in the text. */
export const toVtt = (captions: readonly Caption[]): string =>
  [
    'WEBVTT\n',
    ...captions.map(
      (c) =>
        `${clock(c.start, '.')} --> ${clock(c.end, '.')}\n${lines(c.text)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/-->/g, '--&gt;')}\n`,
    ),
  ].join('\n')
