// A bed baked by tools/pcm-bake.ts, checked against what made it before the film plays it: the
// stamp beside the file (shaderera.analysis/1, kind "pcm-bake") records the module's and every
// listed input's sha256, the seed, the duration and the file's own sha256. Read in `open`.

import { type Host, sha256 } from '@shaderera/core'

type File = { path: string; bytes: number; sha256: string }

/** What the stamp holds. */
export type Baked = {
  format: 'shaderera.analysis/1'
  kind: 'pcm-bake'
  /** The module whose export made the samples. */
  source: { path: string; bytes: number; sha256: string }
  /** The tool and its ffmpeg: provenance only. */
  tool: Record<string, unknown>
  params: { export: string; seed: number; duration: number; bitrate: string | null }
  /** The command that made it, to run again. */
  command: string
  /** The other files listed with --inputs. */
  inputs: File[]
  output: File & { seconds: number; sampleRate: number; channels: number; peak: number }
}

/**
 * The `src` of a baked file, for a clip: `{ src: await loadBaked(host, 'assets/music/bed.m4a'), at: 0 }`.
 * Refuses it when its stamp is missing or of another kind, or when the module, an input, the seed,
 * the duration or the file's bytes are not the ones baked, naming the command to run again.
 */
export const loadBaked = async (host: Host, path: string): Promise<string> => {
  const stamp = path.replace(/\.m4a$/i, '.stamp.json')
  let doc: Baked
  try {
    doc = JSON.parse(new TextDecoder().decode(await host.io.read(stamp))) as Baked
  } catch (e) {
    throw new Error(
      `${path} has no stamp ${stamp} (${(e as Error).message}); bake it with tools/pcm-bake.ts`,
    )
  }
  if (doc.format !== 'shaderera.analysis/1' || doc.kind !== 'pcm-bake')
    throw new Error(`${stamp} is not a shaderera.analysis/1 pcm-bake stamp; bake ${path} again`)
  const again = `; run ${doc.command} again`
  for (const f of [doc.source, ...doc.inputs])
    if ((await sha256(await host.io.read(f.path))) !== f.sha256)
      throw new Error(`${path} was baked from other bytes than ${f.path}${again}`)
  if (doc.params.seed !== host.seed)
    throw new Error(
      `${path} was baked with seed ${doc.params.seed}, the film's is ${host.seed}${again}`,
    )
  if (doc.params.duration !== host.manifest.duration)
    throw new Error(
      `${path} was baked for ${doc.params.duration} s, the film lasts ${host.manifest.duration} s${again}`,
    )
  if ((await sha256(await host.io.read(path))) !== doc.output.sha256)
    throw new Error(`${path} is not the file baked${again}`)
  return path
}
