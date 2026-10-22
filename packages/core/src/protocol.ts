/// <reference types="@webgpu/types" preserve="true" />
/**
 * The Shaderera protocol, as types. Anything that returns the same Frame for the same `t`
 * participates. Every optional member is a capability: the host detects it by its presence, and
 * none of it is required.
 *
 * The protocol standardises how programmable media is controlled, inspected, debugged and
 * rendered, not how creatives are represented: there is no scene, timeline or layer tree here.
 */

/** Plain JSON: what `inspect` returns and what a manifest holds. */
export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json }

/**
 * `shaderera.json`: declarative project metadata that the Studio, the CLI and MCP read and write
 * without running code. It is not a creative representation; nothing about what is drawn goes here.
 */
export type Manifest = {
  /** The JSON Schema an editor checks the file against: the `shaderera` package's. */
  readonly $schema?: string
  /**
   * The file's format, `"manifest/1"`; a file without it is that format too. A host refuses any
   * other: a format change says so instead of reading the file wrongly.
   */
  readonly shaderera?: 'manifest/1'
  /** The module whose default export is an `Open` or a `Source`, relative to the project root. */
  readonly entry: string
  /**
   * A module whose default export is a `MountDom`: the project's own DOM (React, any framework,
   * plain HTML and CSS), which the browser host lays out on its page, sets to each t and draws
   * (HTML-in-Canvas) into `RenderOptions.dom` before it calls `render`. Browser host only.
   */
  readonly dom?: string
  /**
   * The host the project renders in: `node` (a child process with Dawn; the default) or `browser`
   * (headless Chrome's WebGPU and the page's DOM). A project with `dom` must say `browser`. Every
   * tool opens this host (verify, review, jobs, render, MCP); `--host` overrides it for one run.
   */
  readonly host?: 'node' | 'browser'
  /**
   * How many pixels per CSS pixel the browser host draws `dom` with (1 by default, up to 4): the
   * DOM keeps its layout at the frame's size, and `RenderOptions.dom` is `domScale` times larger,
   * for a source that uses it as a texture seen up close. As a layer it is scaled to the frame.
   */
  readonly domScale?: number
  /**
   * Frames a second. In shaderera.json a number or a fraction (`"24000/1001"`); an NTSC rate
   * written as a decimal (23.976, 29.97, 59.94) means its fraction. A host gives the source the
   * rate as that exact number (24000 / 1001), and `t` is `frame / fps`.
   */
  readonly fps: number
  /** In seconds. */
  readonly duration: number
  readonly width: number
  readonly height: number
  /** A JSON Schema (`type: 'object'`) for the params the host passes to `open`. */
  readonly params?: { readonly [key: string]: Json }
  readonly seed?: number
  /**
   * The source carries state from frame to frame (a simulation, a feedback buffer), so `render(t)`
   * alone cannot reconstruct t: the host renders its frames 0, 1, 2… in order and replays them for
   * a jump back, or restores a `checkpoint` the source can take. A number is the source's
   * lookback: frame f depends only on the frames since f − lookback, so a fresh source starts there
   * instead of at frame 0.
   */
  readonly sequential?: true | number
  /**
   * Stamp `source: "file:line:col"` on every object literal with an `id` in the project's files,
   * so pick and inspect lead back to the line. Opt-in: the extra enumerable key reaches code that
   * enumerates or hashes those objects.
   */
  readonly stamp?: true
  /**
   * Named outputs the composition is designed for, such as a vertical cut or a 6 s cutdown. A
   * host opens the source with the variant applied to `host.manifest` (and its params over the
   * defaults); the source lays itself out from that. A variant is never a crop.
   */
  readonly variants?: { readonly [name: string]: Variant }
  /**
   * Time before the programme in the delivered file (a broadcast slate or black): `seconds`,
   * filled with opaque black and silence, or by the source rendering t from `-seconds` to 0
   * (`fill: 'source'`: a slate drawn as the film's own code). The film's t = 0 stays where it is.
   */
  readonly preroll?: Preroll
  /** The programme's start timecode, `HH:MM:SS:FF` (`;FF` drop-frame), written into the file. */
  readonly timecode?: string
  /**
   * A textless version (for localising over it): review fails it when inspect or the DOM shows
   * text, and asks no `copy` of it.
   */
  readonly textless?: true
  /**
   * Frames the film reads that were made outside the host (a path tracer with a native denoiser
   * that keeps history, say), by name. `shaderera bake <name>` runs the bake's command and stamps
   * what it made; every command that renders refuses a bake whose inputs or frames changed since.
   * The source reads them through `io.bake` (decision 0016).
   */
  readonly bakes?: { readonly [name: string]: Bake }
  /**
   * What the project needs installed (decision 0008): a range of the `shaderera` package, and
   * package plugins by name with a range. `shaderera add` and `remove` keep `extensions`; every
   * command refuses a project whose requirements are not met. Nothing in it changes a frame.
   */
  readonly requires?: Requires
}

/** What a project needs installed: the `shaderera` range and package plugins with their ranges. */
export type Requires = {
  readonly shaderera?: string
  readonly extensions?: { readonly [name: string]: string }
}

/** Frames made outside the host: how they are made, from what, and where they are. */
export type Bake = {
  /** Run by `shaderera bake` in the project folder, with the person's rights; never by a render. */
  readonly command: string
  /** The project files and folders the frames derive from. */
  readonly inputs: readonly string[]
  /** The folder the command writes: in the project, or an absolute path anywhere. */
  readonly dir: string
  /** How the frames are named in `dir`, `#`s for the frame number: `beauty.####.jpg`, from 0. */
  readonly frames: string
}

/** Time before the programme: `seconds` of black, or of the source at negative t. */
export type Preroll = { readonly seconds: number; readonly fill?: 'black' | 'source' }

/** One designed output: what it overrides in the manifest, and the params it sets. */
export type Variant = {
  readonly label?: string
  readonly width?: number
  readonly height?: number
  readonly duration?: number
  readonly fps?: number
  readonly params?: { readonly [key: string]: Json }
  /**
   * Time before the programme in the delivered file (a broadcast slate or black): `seconds`,
   * filled with opaque black and silence, or by the source rendering t from `-seconds` to 0
   * (`fill: 'source'`: a slate drawn as the film's own code). The film's t = 0 stays where it is.
   */
  readonly preroll?: Preroll
  /** The programme's start timecode, `HH:MM:SS:FF` (`;FF` drop-frame), written into the file. */
  readonly timecode?: string
  /**
   * A textless version (for localising over it): review fails it when inspect or the DOM shows
   * text, and asks no `copy` of it.
   */
  readonly textless?: true
}

/** What the host gives a source when it opens it. Everything async happens once, in `open`. */
export type Host = {
  readonly manifest: Manifest
  readonly params: { readonly [key: string]: Json }
  readonly seed: number
  readonly io: Io
  /** Offered when the host has WebGPU; never required. */
  readonly gpu?: GPUDevice
}

/**
 * The host's narrow ports, so the same code runs in the browser and in Node. Paths are relative
 * to the project root.
 */
export type Io = {
  read(path: string): Promise<Uint8Array>
  /**
   * A canvas with a 2D context: an `OffscreenCanvas` in the browser, `@napi-rs/canvas` in Node.
   * Only its 2D context is portable. In Node, `getImageData`'s pixels share the canvas's memory:
   * copy them before the canvas is drawn again.
   */
  canvas(width: number, height: number): OffscreenCanvas
  /** Registers a font file under a family name for the 2D context. */
  font(path: string, family: string): Promise<void>
  /**
   * A PNG or JPEG decoded in JavaScript, the same pixels in every host (never a browser's or a
   * canvas's decoder): straight RGBA, sRGB code values as the file has them, 8 bits a channel, or
   * 16 for a 16-bit PNG. Decoded once per file in a host. Other formats: convert them to PNG once.
   */
  image?(path: string): Promise<DecodedImage>
  /**
   * A video file's frames, decoded in software by the host's ffmpeg: `frame(i)` is frame i as
   * straight RGBA (sRGB, full range, by the file's own colour tags), the same bytes every time, read
   * in order fastest. Which frame a t shows is the film's choice (`fps` is the file's).
   */
  video?(path: string): Promise<Footage>
  /**
   * Bytes derived from inputs, kept across renders, hosts and runs (`.shaderera/cache/`): `make`
   * runs only when nothing is kept for `key` with these project files as they are now. `key`
   * names what is made and how (put a version in it); `inputs` are the project paths it reads.
   */
  cache?(
    key: string,
    inputs: readonly string[],
    make: () => Promise<Uint8Array>,
  ): Promise<Uint8Array>
  /**
   * A bake's frames (`manifest.bakes`), as `shaderera bake` stamped them: the host checked them
   * before the source opened. Frame `index` is the file the bake's `frames` names with that number.
   */
  bake?(name: string): Promise<Baked>
}

/** A bake's frames, opened: the file's bytes, or the image decoded as `image` decodes it. */
export type Baked = {
  readonly frames: number
  read(index: number): Promise<Uint8Array>
  image(index: number): Promise<DecodedImage>
}

/** A decoded image: rows from the top, straight RGBA. */
export type DecodedImage = {
  readonly width: number
  readonly height: number
  readonly bits: 8 | 16
  readonly data: Uint8Array | Uint16Array
}

/** A video file opened for its frames. */
export type Footage = {
  readonly width: number
  readonly height: number
  /** The file's frame rate. */
  readonly fps: number
  readonly frames: number
  /** Frame `index` (0-based) as straight RGBA bytes, `width × height × 4`. */
  frame(index: number): Promise<Uint8Array>
  /**
   * Stops the decoder and frees its buffers: a film with many clips closes each when its shot
   * ends. A `frame(i)` after it opens the file again and gives the same bytes.
   */
  close(): Promise<void>
}

/** A project's entry exports this, or a `Source` itself. */
export type Open = (host: Host) => Source | Promise<Source>

export type Source = {
  /** Resolves when the frame for `t` is ready. The host never overlaps calls on one source. */
  render(t: number, options: RenderOptions): Promise<Frame>
  /** Any JSON. Optional keys on any object in it: `id` (stable across t) and `source` (file:line:col). */
  inspect?(t: number): Promise<Json>
  pick?(t: number, x: number, y: number): Promise<Pick | null>
  camera?: CameraCapability
  /** Clips the host mixes into preview and export. */
  audio?(): Promise<readonly AudioClip[]>
  /** Captions the host writes as sidecar files beside an export (SRT, WebVTT). */
  captions?(): Promise<readonly Caption[]>
  /** A `sequential` source's state, so the host can seek without replaying from frame 0. */
  checkpoint?: CheckpointCapability
  dispose?(): void
}

/**
 * Save and restore for a `sequential` source. `save` is the state after the frame the source
 * rendered last, as plain data (anything structured clone copies: typed arrays, objects); `restore`
 * puts that state into this source or into another one opened with the same params, seed and
 * manifest, so that its next frame is the one after the saved frame. The host keeps checkpoints
 * with the inputs they were taken under and restores one only when those match.
 */
export type CheckpointCapability = {
  save(): Promise<unknown>
  restore(state: unknown): Promise<void>
}

export type RenderOptions = {
  readonly width: number
  readonly height: number
  /**
   * The frame this render is: `Math.round(t * fps)`. `t` is exactly `frame / fps` in check and
   * export, and may fall between frames in a preview scrub. A source that steps a simulation counts
   * frames with it, never with a wall clock or a float sum.
   */
  readonly frame: number
  /** `preview` may be approximate or progressive; `final` is what export uses. */
  readonly intent: 'preview' | 'final'
  /** Aborted when a scrub makes this render stale. */
  readonly signal?: AbortSignal
  /** A camera to render through, for a source that can (see `CameraCapability`). */
  readonly camera?: Matrices
  /**
   * The project's DOM (`manifest.dom`) drawn at this t, at the frame's size, straight alpha: a
   * layer to return, or a texture for the source's own renderer. Absent without `manifest.dom` and
   * in a host without a page (Node). The host owns it and closes it after this frame is composited;
   * a source that needs its pixels later copies them.
   */
  readonly dom?: ImageBitmap
}

/**
 * `manifest.dom`'s default export: lays the project's DOM out in `element` (the frame's size) and
 * returns how to set it to a time. The host draws it after `seek` resolves and the page has painted.
 */
export type MountDom = (
  element: HTMLElement,
  host: { readonly manifest: Manifest; readonly params: { readonly [key: string]: Json } },
) => Promise<DomView> | DomView

export type DomView = {
  /** Shows time t; resolves when what t shows is in the DOM. */
  seek(t: number): void | Promise<void>
  dispose?(): void
}

/**
 * One layer, or a flat bottom-to-top stack of layers that the host composites `over`. Never
 * nested: a composition flattens what its children return, so no hierarchy crosses the boundary.
 */
export type Frame = Layer | readonly Layer[]

/** What a layer may carry besides its pixels. Debugging information, never creative structure. */
export type LayerInfo = {
  /** A label the Studio shows in its layer list. */
  readonly name?: string
  /** `false`: a progressive preview that a later call refines. */
  readonly final?: boolean
  /**
   * Where the layer's pixels are: the host depth-tests layers that carry it against each other
   * (a nearer opaque pixel hides what comes later behind it), so a layer drawn by one renderer
   * can stand inside another's scene. Layers without it composite `over` as always.
   */
  readonly depth?: Depth
}

/**
 * Pixels at the requested size. A canvas, bitmap or video frame knows its own alpha; raw RGBA
 * bytes say how theirs is stored.
 */
export type Layer =
  | ({ readonly color: OffscreenCanvas | ImageBitmap | VideoFrame } & LayerInfo)
  | ({
      /**
       * Raw RGBA bytes; or a texture of `host.gpu` at the frame's size with `TEXTURE_BINDING`,
       * which the host composites with no copy (an `-srgb` format is encoded back to sRGB).
       */
      readonly color: Uint8Array | Uint8ClampedArray | GPUTexture
      readonly alpha: 'premultiplied' | 'straight' | 'opaque'
    } & LayerInfo)

/** One distance per pixel, row by row; Infinity where the layer is nowhere. */
export type Depth = {
  readonly data: Float32Array
  /** Every layer of a frame that carries depth uses the same kind and units. */
  readonly kind: 'view-z' | 'ray-distance'
  /** Metres per depth unit. */
  readonly units: number
  /** How far behind, in depth units, a pixel fades out rather than cutting off (0: a hard edge). */
  readonly soft?: number
}

/** Sixteen numbers, column-major. */
export type Mat4 = readonly number[]
export type Vec3 = readonly [number, number, number]

/**
 * A camera, exchanged as matrices: every renderer already has them. Projection is in WebGPU clip
 * space (z in [0, 1]). Core has no camera model (decision 0009): the source keeps its own and
 * reports it in `inspect`. This hook is optional and frozen; it serves debugging tools, for
 * cameras a view and projection can describe. A source with another kind, or several, leaves
 * `camera` out.
 */
export type Matrices = {
  readonly view: Mat4
  readonly projection: Mat4
  readonly up?: Vec3
  /** Metres per world unit. */
  readonly units?: number
}

export type CameraCapability = {
  /** What the source looks through at t. */
  get(t: number): Promise<Matrices>
  /** The Studio's free camera; `null` gives control back to the source. */
  override?(matrices: Matrices | null): void
}

export type Pick = {
  /** The `id` of the picked object in `inspect`. */
  readonly id: string
  /** The world point hit, if the source knows it. */
  readonly point?: Vec3
}

export type AudioClip = {
  /** A project file; or none, with `pcm`. */
  readonly src?: string
  /**
   * Sound made in code instead of a file: one Float32Array per channel (1 or 2) at
   * `sampleRate`, values in [-1, 1]. Computed in `open` or `audio()`, from the seed, never
   * from a clock.
   */
  readonly pcm?: Pcm
  /** Where the clip starts, in seconds of the composition. */
  readonly at: number
  /** Where to start reading in the file, in seconds. */
  readonly from?: number
  /** Where to stop reading in the file, in seconds. */
  readonly to?: number
  /**
   * A linear gain (1: as the file is), or a function of the composition's time in seconds that
   * returns one: a fade, a duck, any envelope, written as code like `render(t)`. The host samples
   * the function every millisecond over the composition and interpolates between samples. It must
   * be a pure function of t, and return a finite number.
   */
  readonly gain?: number | ((t: number) => number)
  /**
   * The stem the clip belongs to (`dialogue`, `music`, `fx`…): a render can write one WAV per
   * group beside the mix, the stems summing to it. Letters, digits, `.`, `_` and `-`.
   */
  readonly group?: string
}

/**
 * One caption: text shown from `start` to `end`, in seconds of the composition. The host writes
 * the captions as SRT and WebVTT sidecars beside an export; they are never drawn into the frame.
 * `end` is finite and after `start` (an LRC cue from `text-timed-cues` ends at `Infinity` until
 * the film ends it). Review measures captions against requirements.json (docs/delivery.md).
 */
export type Caption = {
  readonly start: number
  readonly end: number
  /** Plain text; a line break is `\n`. */
  readonly text: string
}

/**
 * A clip as a host passes it on: a function gain sampled into `GainCurve` (functions do not cross
 * process or worker boundaries).
 */
export type SampledClip = Omit<AudioClip, 'gain'> & { readonly gain?: number | GainCurve }

/** A gain sampled `rate` times a second from t = 0 of the composition. */
export type GainCurve = { readonly rate: number; readonly values: readonly number[] }

/** Samples made in code: one channel or two, the same length. */
export type Pcm = { readonly sampleRate: number; readonly channels: readonly Float32Array[] }
