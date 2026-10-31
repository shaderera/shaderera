import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Placement } from '../deliver/placement.ts'
import { readJson } from '../node/json.ts'
import type { CaptionLimits } from '../review/measure.ts'
import type { Timing } from '../review/timing.ts'

/**
 * What a brief fixes, what was inferred, what is missing and how each item stands: the project's
 * `requirements.json`. The authoring agent writes it from the brief; review and deliver check
 * against it. It holds requirements, never the film.
 *
 * Review measures everything, but judges only what is declared here (decision 0011): a craft
 * rule such as an end hold, a reading time or a safe area fails a film only when the person set it.
 */
export type Requirements = {
  version: 1
  /** The brief as the person gave it. */
  brief?: string
  /**
   * Exact copy that must appear verbatim (whitespace normalised) in some text run of every output,
   * or only of the outputs `variants` names (`main` is the manifest's own format): Thai lines in
   * the Thai variants, say.
   */
  copy?: { text: string; id?: string; locked?: boolean; variants?: string[] }[]
  /** The main output: size, rate, length. */
  format?: { width?: number; height?: number; fps?: number; duration?: number }
  /** Named variants (shaderera.json `variants`) that must be delivered. */
  variants?: string[]
  /** Text must stay inside this margin, as fractions of width/height: the placement's safe area. */
  safeArea?: { top: number; right: number; bottom: number; left: number }
  /** The closing frame must hold still at least this long, in seconds. */
  endHold?: number
  /**
   * Each text must stay on screen at least `min` seconds, or its characters / `charsPerSecond`
   * when that is longer: review's `reading` check fails a text shown for less.
   */
  readingTime?: { min: number; charsPerSecond: number }
  /**
   * At most this fraction of the smaller of two text boxes may overlap at one t (0.1: 10 %):
   * review's `text-overlap` check fails a pair that overlaps more.
   */
  textOverlap?: number
  /** No flat frame outside the first and last 0.3 s: review's `blank-frames` check fails on one. */
  noBlankFrames?: true
  /**
   * The footage holds the film means (an intended freeze): each marks the hold of one frame on
   * screen at `at` seconds, of the clip at `clip` (any clip when absent). Declared, even as `[]`,
   * review's `footage-hold` check fails every other hold longer than 0.3 s; unset, holds are info.
   */
  footageHolds?: { at: number; clip?: string; note?: string }[]
  /**
   * Limits on the subtitle sidecar (`captions()`): characters per second, characters in a line
   * and lines (grapheme clusters), and the shortest duration and gap in seconds. Review's
   * `captions` check fails a caption over a declared one; unset, they are measured as info.
   */
  captions?: CaptionLimits
  /**
   * Timings the author checks against inspect: a value at a path at a time (`at`) or over a
   * window (`from`, `to`), equal to, at least or at most a value, or holding still or moving
   * (`changes`). Review's `timing` check fails one that does not hold. No default set.
   */
  timing?: Timing[]
  /**
   * The placement each output is delivered to, by variant name (`main` is the manifest's own
   * format): `deliver` checks the file against it (container, codec, size, rate, length, bytes,
   * bitrate, audio, loudness, edit list, transfer, bit depth, HDR10 metadata) and review judges
   * text against its safe area. The SDR render beside an HDR10 one (`deliver --hdr10 --sdr`) takes
   * `<variant>:sdr` (`main:sdr`), and no placement without one.
   */
  placements?: { [output: string]: Placement }
  /** This output's placement: set by outputRequirements from `placements`. */
  placement?: Placement
  /**
   * What must not change: a file; a stamped id (its inspect values); a time (the beats and shots
   * at that time stay there, while what they show may change); or a frame (its pixels, for a
   * frame a person approved). The broker refuses a change that breaks a lock.
   */
  locks?: Lock[]
  /** Every requirement with its kind and status, as the Requirements view shows them. */
  items?: RequirementItem[]
}

export type Lock =
  | { kind: 'file'; path: string; note?: string }
  | { kind: 'id'; id: string; note?: string }
  /**
   * An exact timestamp: whatever inspect reports with an `id` and an `at` at this time (a beat, a
   * shot), or only `id` when given, stays at this time. The frame's content may change.
   */
  | { kind: 'time'; at: number; id?: string; note?: string }
  /** An approved frame: its pixels stay exactly as they are. */
  | { kind: 'frame'; at: number; note?: string }

export type RequirementItem = {
  id: string
  text: string
  kind: 'explicit' | 'inferred' | 'missing' | 'conflict'
  status: 'met' | 'unmet' | 'unknown' | 'blocked'
  evidence?: string
}

export const REQUIREMENTS = 'requirements.json'

/** The project's requirements, or an empty set when it has none; throws on a malformed file. */
export const readRequirements = (root: string): Requirements => {
  const file = join(root, REQUIREMENTS)
  if (!existsSync(file)) return { version: 1 }
  const value = readJson<Requirements>(file)
  if (value === null || typeof value !== 'object' || value.version !== 1)
    throw new Error(`${REQUIREMENTS}: expected an object with "version": 1`)
  return value
}

/**
 * What one output is checked against, the same for review (CLI, MCP) and
 * delivery: the copy meant for it, and for a variant its own format (requirements.json's
 * `format` describes the main output). The safe area is the project's own, when it sets one:
 * there is no default placement (decision 0011).
 */
export const outputRequirements = (
  req: Requirements,
  output: {
    variant?: string
    width: number
    height: number
    fps: number
    duration: number
    /** A textless version: no copy is asked of it. */
    textless?: boolean
    /** The SDR render beside an HDR10 one: its placement is `<variant>:sdr`. */
    sdr?: boolean
  },
): Requirements => ({
  ...req,
  ...placementOf(req, `${output.variant ?? 'main'}${output.sdr ? ':sdr' : ''}`),
  ...(req.copy
    ? {
        copy: output.textless
          ? []
          : req.copy.filter(
              (c) => !Array.isArray(c.variants) || c.variants.includes(output.variant ?? 'main'),
            ),
      }
    : {}),
  ...(output.variant
    ? {
        format: {
          width: output.width,
          height: output.height,
          fps: output.fps,
          duration: output.duration,
        },
      }
    : {}),
})

/** An output's placement, and its safe area when the requirements set none of their own. */
const placementOf = (req: Requirements, key: string): Partial<Requirements> => {
  const placement = req.placements?.[key]
  if (!placement) return {}
  return {
    placement,
    ...(placement.safeArea && !req.safeArea ? { safeArea: placement.safeArea } : {}),
  }
}

type GateCheck = {
  id: string
  title: string
  status: 'pass' | 'fail' | 'unknown' | 'info'
  required?: boolean
  detail?: string
}

/**
 * The checks a project's requirements need to pass. Every project: it builds and opens, its
 * requirements read, it renders the same twice, its assets load. Then what it asks for: a format,
 * exact copy (with its glyphs, inside the frame or the safe area), a safe area, an end hold, a
 * reading time, a text overlap limit, no blank frames, the footage holds meant, caption limits. Nothing else is judged (decision 0011).
 */
export const requiredChecks = (r: Requirements): Set<string> =>
  new Set([
    'build',
    'requirements',
    'determinism',
    'assets',
    ...(r.format ? ['format'] : []),
    ...(r.copy?.length ? ['copy', 'glyphs', 'text-fit'] : []),
    ...(r.safeArea ? ['text-fit'] : []),
    ...(r.endHold !== undefined ? ['end-hold'] : []),
    ...(r.readingTime ? ['reading'] : []),
    ...(r.textOverlap !== undefined ? ['text-overlap'] : []),
    ...(r.noBlankFrames ? ['blank-frames'] : []),
    ...(r.footageHolds ? ['footage-hold'] : []),
    ...(r.captions ? ['captions'] : []),
    ...(r.timing?.length ? ['timing'] : []),
    ...(r.placement ? ['placement'] : []),
  ])

/**
 * Marks the required checks and adds a failure for each required one that never ran (`build` and
 * `requirements` are the broker's own, reported where it verifies). A required check passes only on `pass`: unknown is not evidence.
 */
export const gate = <C extends GateCheck>(checks: C[], r: Requirements): (C | GateCheck)[] => {
  const need = requiredChecks(r)
  const absent = [...need].filter(
    (id) => id !== 'build' && id !== 'requirements' && !checks.some((c) => c.id === id),
  )
  return [
    ...checks.map((c) => (need.has(c.id) ? { ...c, required: true } : c)),
    ...absent.map((id) => ({
      id,
      title: id,
      status: 'fail' as const,
      required: true,
      detail: 'required by the requirements, but not checked',
    })),
  ]
}
