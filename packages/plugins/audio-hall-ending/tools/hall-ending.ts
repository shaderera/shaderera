// An ending that rings out: the song's last chord is sent into a hall, the tail dies to digital
// silence, and the film holds in that silence. For a song that stops dead, as generated music
// often does. Needs ffmpeg on PATH.
//
//   node tools/hall-ending.ts --in audio/song.mp3 --out audio/song-end.wav --send 43.95
//     [--end <s>] [--rt 3.5] [--wet 31] [--quiet <s>] [--gone <s>] [--trim 0] [--duration <s>]
//
// --send     where the hall opens, in song seconds: just before the cadence or the last hit
// --end      where the song itself goes silent (default: its length)
// --rt       the hall's reverberation time to -60 dB
// --wet      the hall's level in dB. ffmpeg's afir normalises the hall to its peak, so its tail
//            comes out far under the dry song: about 30 dB brings it back. Set it by ear.
// --quiet    the tail starts fading out here… (default: end + 0.7 × rt)
// --gone     …and is digital silence here (default: end + 0.95 × rt)
// --trim     seconds cut from the song's start (the film starts later in the song)
// --duration the output's length in film seconds (default: until gone, plus a second of silence)
//
// Writes 48 kHz, 24-bit stereo WAV. Analyse the result (audio-beat-clock's tools/analyze-music.ts), not
// the source, so the picture is cut to the file it plays.

import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    in: { type: 'string' },
    out: { type: 'string' },
    send: { type: 'string' },
    end: { type: 'string' },
    rt: { type: 'string', default: '3.5' },
    wet: { type: 'string', default: '31' },
    quiet: { type: 'string' },
    gone: { type: 'string' },
    trim: { type: 'string', default: '0' },
    duration: { type: 'string' },
  },
})
if (!values.in || !values.out || !values.send)
  throw new Error('Usage: node tools/hall-ending.ts --in <song> --out <wav> --send <seconds>')

const length = (path: string) =>
  Number(
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=nw=1:nk=1',
      path,
    ])
      .toString()
      .trim(),
  )
const SEND = Number(values.send)
const END = values.end ? Number(values.end) : length(values.in)
const RT = Number(values.rt)
const WET = Number(values.wet)
const QUIET = values.quiet ? Number(values.quiet) : END + 0.7 * RT
const GONE = values.gone ? Number(values.gone) : END + 0.95 * RT
const TRIM = Number(values.trim)
const DURATION = values.duration ? Number(values.duration) : GONE + 1 - TRIM
const OPEN = 0.15 // the send opens over this long

const f = (x: number) => x.toFixed(4)
const k = Math.log(1000) / RT
const bright = k * 3.5 // the early tail is brighter and dies faster
const decay = `(exp(-t*${f(k)})+0.6*exp(-t*${f(bright)}))`

execFileSync('ffmpeg', [
  '-v',
  'error',
  '-y',
  '-i',
  values.in,
  '-filter_complex',
  [
    // The hall: decaying stereo noise, darker as it goes, the channels a few ms apart.
    `aevalsrc=exprs='(random(0)*2-1)*${decay}|(random(1)*2-1)*${decay}':d=${RT + 0.5}:s=48000,lowpass=f=5200,adelay=23|31[ir]`,
    '[0:a]asplit[dry][send]',
    `[send]atrim=start=${f(SEND)},asetpts=PTS-STARTPTS,afade=t=in:d=${OPEN},apad=pad_dur=${RT + 1}[in]`,
    `[in][ir]afir,volume=${WET}dB,adelay=${Math.round(SEND * 1000)}:all=1[wet]`,
    `[dry]afade=t=out:st=${f(END - 0.02)}:d=0.02[d]`,
    `[d][wet]amix=inputs=2:normalize=0:duration=longest,afade=t=out:st=${f(QUIET)}:d=${f(GONE - QUIET)},atrim=start=${f(TRIM)},asetpts=PTS-STARTPTS${TRIM > 0 ? ',afade=t=in:d=0.3' : ''},apad=whole_dur=${f(DURATION)}[out]`,
  ].join(';'),
  '-map',
  '[out]',
  '-t',
  f(DURATION),
  '-ar',
  '48000',
  '-ac',
  '2',
  '-c:a',
  'pcm_s24le',
  values.out,
])
console.log(
  `${values.out}: from ${TRIM} s, the ending ringing in a ${RT} s hall from ${SEND} s, silent by ${f(GONE - TRIM)} s, ${f(DURATION)} s long`,
)
