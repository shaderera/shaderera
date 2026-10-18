// The player tests' film: a copy of fixtures/footage with its clip made by ffmpeg (no media file is
// kept in the repository) and its bake made and stamped.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findProject } from '../../node/project.ts'
import { makeBake } from '../../project/bakes.ts'

export const ffmpeg =
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0

/**
 * The clip: testsrc2 (it changes every frame, so a frame shown one off is a large difference),
 * 320×180, 30 fps, 1 s, H.264 with B-frames and one keyframe, so the proxy is not a copy.
 */
export const makeClip = (file: string) => {
  const r = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x180:r=30:d=1',
      '-c:v',
      'libx264',
      '-g',
      '250',
      '-bf',
      '2',
      '-pix_fmt',
      'yuv420p',
      file,
    ],
    { encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`)
}

export const footageProject = async () => {
  const root = join(mkdtempSync(join(tmpdir(), 'shaderera-player-')), 'film')
  cpSync(fileURLToPath(new URL('./footage/', import.meta.url)), root, { recursive: true })
  mkdirSync(join(root, 'assets'))
  makeClip(join(root, 'assets', 'clip.mp4'))
  const project = await findProject(root)
  makeBake(root, project.manifest, 'level')
  return project
}
