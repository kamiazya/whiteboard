// Render a `SpatialCanvas` to PNG/SVG without an attached browser client.
//
// Pipeline:
//   1. canvas-render's `layoutSpatialCanvas` turns the persisted canvas
//      into a canvas-render `Scene`, using the vendored opentype.js
//      measurer (measure-text.ts) as the injected text-measurement seam,
//      codec's `parseMarkdownBody` as the injected body parser, and
//      canvas-render's shared `createSpatialTheme({ mode: 'light' })` as
//      the injected appearance resolver — export is deliberately pinned to
//      light (package-canvas-render.md decision #8) so a user's UI theme
//      can never change exported bytes.
//   2. `renderSceneToSvg` (canvas-render) serializes the scene to an SVG
//      string, with document options (padding/background) so the root
//      carries a real `width`/`height`/`viewBox` envelope — canvas-render
//      emits the bare, undimensioned root when no document option is set,
//      which would hand resvg a degenerate raster.
//   3. `@resvg/resvg-js` rasterises that SVG to PNG, with the vendored
//      Roboto TTF registered directly and system-font loading disabled, so
//      the same canvas rasterises identically on any machine.
//
// This module is process-singleton: buildExporter() — invoked lazily by
// getHeadlessExporter() — warms the font measurer and resvg's module
// import once per process; every render call after that reuses the result.

import type {
  MeasureText,
  Scene,
  SpatialLayoutDegradation,
} from '@kamiazya/whiteboard-canvas-render'
import {
  createSpatialTheme,
  layoutSpatialCanvas,
  renderSceneToSvg as renderSceneToSvgString,
  SPATIAL_DARK_PALETTE,
  SPATIAL_LIGHT_PALETTE,
} from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'

import { getLogger } from '../log.js'
import { EXPORT_FONT_FAMILY, resolveExportFontFaces } from './export-font.js'
import { installedFontFiles } from './installed-fonts.js'
import { createOpentypeMeasureText, loadExportFonts } from './measure-text.js'
import { undrawableCharacters } from './undrawable-characters.js'
import { unresolvedFamilies } from './unresolved-families.js'

// Export never has its own theme switch (the composition root always
// exports light, see package-canvas-render.md decision #8), so this
// singleton is built once and reused across renders.
const EXPORT_APPEARANCE_BY_MODE = {
  light: createSpatialTheme({ mode: 'light' }),
  dark: createSpatialTheme({ mode: 'dark' }),
} as const
type ExportThemeMode = keyof typeof EXPORT_APPEARANCE_BY_MODE

const log = getLogger('headless-renderer')

let setupPromise: Promise<HeadlessExporter> | null = null

export interface HeadlessExportOptions {
  // padding: extra px around the content bounds. Default mirrors the
  // previous browser export (10).
  padding?: number
  // scale: pixel scale factor. 1 = 100%, 2 = retina-equivalent. Default 1.
  scale?: number
  // background: CSS color or 'transparent'. Default '#ffffff' (or dark
  // default when `theme` is 'dark' and no explicit background is supplied).
  background?: string
  // theme: forces light/dark background on the rendered scene. `frameId`
  // and `minFontPx` are accepted upstream (exportRequestSchema) for wire
  // compatibility but are Excalidraw-era concepts with no SpatialCanvas
  // equivalent (no frame grouping, no per-element fontSize to clamp) — this
  // renderer never reads them.
  theme?: 'light' | 'dark'
}

// The mode surfaces come from the shared palette — the same color the
// label halo knocks text backgrounds out with, so an exported label pill
// is invisible against the export background.
const DARK_DEFAULT_BACKGROUND = SPATIAL_DARK_PALETTE.surface
const LIGHT_DEFAULT_BACKGROUND = SPATIAL_LIGHT_PALETTE.surface
const DEFAULT_PADDING_PX = 10

export interface HeadlessExportResult {
  png: Buffer
  width: number
  height: number
  /**
   * Characters this renderer's own fonts have no glyph for, which resvg has
   * therefore painted as tofu boxes.
   *
   * Reported because of HOW that fails: measurement falls back to the
   * estimator per code point, so the box is the right size, the text wraps
   * correctly, and every other signal says the render is fine. The only thing
   * wrong is that the reader cannot read it.
   *
   * Empty is the answer for a Latin canvas, and for one where the vendored
   * face was unreachable at all — that degradation is a different condition,
   * logged where it happens.
   */
  undrawable: readonly string[]
  /**
   * Font families this render DECLARED that no loaded face provides, so
   * resvg drew them in the fallback. Distinct from `undrawable`, which is
   * family-blind: every character can be present and still be painted in the
   * wrong face, which is a silent loss rather than a visible one.
   */
  unresolvedFamilies: readonly string[]
}

export interface HeadlessSvgExportResult {
  svg: string
  /**
   * Same question as `HeadlessExportResult.undrawable`, but SVG keeps the
   * characters as `<text>` — a viewer whose system carries the face reads
   * them normally. This says what THIS renderer could not draw, which is what
   * the PNG of the same canvas would lose.
   */
  undrawable: readonly string[]
  /** Same question as `HeadlessExportResult.unresolvedFamilies`. */
  unresolvedFamilies: readonly string[]
}

interface HeadlessExporter {
  render(canvas: SpatialCanvas, options: HeadlessExportOptions): Promise<HeadlessExportResult>
  renderSvg(canvas: SpatialCanvas, options: HeadlessExportOptions): Promise<HeadlessSvgExportResult>
}

function themeBackground(options: HeadlessExportOptions): string {
  if (options.background) return options.background
  return options.theme === 'dark' ? DARK_DEFAULT_BACKGROUND : LIGHT_DEFAULT_BACKGROUND
}

/** Reports a layout degradation via `getLogger`, since canvas-render itself cannot log. */
function onDegrade(event: SpatialLayoutDegradation): void {
  switch (event.kind) {
    case 'body-parse-failed':
      log.warning(
        { nodeId: event.nodeId, err: event.err },
        'text node body failed to parse as markdown; falling back to literal text',
      )
      return
    case 'unsupported-background-style':
      log.warning(
        { nodeId: event.nodeId, style: event.style },
        'group backgroundStyle not supported; rendering as cover',
      )
      return
    case 'unknown-node-kind':
      log.warning(
        { nodeId: event.nodeId, type: event.type },
        'unrecognized spatial node kind; emitting chrome only',
      )
      return
  }
}

/**
 * Composes the export `Scene` from a `SpatialCanvas`, using canvas-render's
 * shared theme and geometry with no override. Exported (not `_forTests`)
 * specifically so a conformance test can lay out a fixture through this
 * exact call site with an injected fake measurer, instead of a real
 * opentype.js font load — see
 * `headless-renderer-geometry-conformance.test.ts`.
 */
export function buildSpatialScene(
  canvas: SpatialCanvas,
  measure: MeasureText,
  mode: ExportThemeMode = 'light',
): Scene {
  return layoutSpatialCanvas(canvas, {
    measure,
    appearance: EXPORT_APPEARANCE_BY_MODE[mode],
    onDegrade,
  })
}

/**
 * The SVG and the scene it came from. The scene is returned rather than
 * rebuilt because the caller needs it to report which declared font families
 * this render could not resolve, and laying the canvas out twice to answer
 * that would cost the whole of layout for a report.
 */
function buildSvg(
  canvas: SpatialCanvas,
  options: HeadlessExportOptions,
  measure: MeasureText,
): { svg: string; scene: Scene } {
  // `theme` is an explicit per-request argument — the invariant that a
  // user's ambient UI theme never changes exported bytes is untouched.
  const mode: ExportThemeMode = options.theme === 'dark' ? 'dark' : 'light'
  const scene = buildSpatialScene(canvas, measure, mode)
  const svg = renderSceneToSvgString(scene, {
    padding: options.padding ?? DEFAULT_PADDING_PX,
    background: themeBackground(options),
    // Dark node chrome uses transparent fills, so body runs sit directly on
    // the dark background — the root-level inheritable fill is what keeps
    // them legible. Light stays byte-identical (no root fill).
    ...(mode === 'dark' ? { textFill: SPATIAL_DARK_PALETTE.labelFill } : {}),
  })
  return { svg, scene }
}

/**
 * The families the loaded faces actually provide, for `unresolvedFamilies`.
 *
 * The name lives under a PLATFORM record, and which one a face carries is not
 * fixed — the vendored Roboto has `windows` and nothing else, while
 * opentype.js's typings advertise a flat `names.fontFamily` that is undefined
 * there. Reading only the typed path returned no families at all, which made
 * every declaration resolve against an empty set and the report silently
 * empty. All three shapes are read, and the English entry preferred because
 * that is what a `font-family` declaration is written against.
 */
async function availableFamilies(): Promise<readonly string[]> {
  const fonts = await loadExportFonts()
  return fonts.flatMap((font) => {
    const names = font.names as unknown as Record<string, Record<string, unknown> | undefined>
    for (const record of [names.windows, names.macintosh, names]) {
      const family = record?.fontFamily as Record<string, string> | string | undefined
      const name =
        typeof family === 'string' ? family : (family?.en ?? Object.values(family ?? {})[0])
      if (typeof name === 'string' && name !== '') return [name]
    }
    return []
  })
}

async function buildExporter(): Promise<HeadlessExporter> {
  const measure = await createOpentypeMeasureText()
  const { Resvg } = await import('@resvg/resvg-js')
  const faces = await resolveExportFontFaces()
  if (!faces.regular) {
    // Silent system-font fallback would mask a regression that diverges
    // visually across machines, so log it once when the singleton is
    // built. Production daemons typically run with the bundled TTF.
    log.warning('Roboto TTF not found; rendering will fall back to system fonts.')
  }
  // Skip resvg's system-font scan when we have the vendored fonts in hand.
  // The scan dominates first-call latency (~1s+) and no other family
  // appears in the SVG canvas-render produces. All four faces register:
  // resvg selects among them by the font-weight/font-style the SVG
  // declares, and it does NOT synthesize a face it was not given.
  // The vendored faces plus whatever the user installed. Resolved per render
  // rather than once with the exporter singleton: installing a font must take
  // effect on the next export, not on the next daemon restart.
  const fontFiles = [faces.regular, faces.bold, faces.italic, faces.boldItalic].filter(
    (path): path is string => path !== null,
  )
  const fontOption = faces.regular
    ? { fontFiles, loadSystemFonts: false, defaultFontFamily: EXPORT_FONT_FAMILY }
    : { loadSystemFonts: true }

  return {
    async render(canvas, options) {
      const { svg, scene } = buildSvg(canvas, options, measure)
      const scale = options.scale ?? 1
      // A non-finite, zero, or negative scale is not a valid zoom factor for
      // resvg (it throws on a zero/negative target size) — degrade to an
      // unscaled render rather than propagating a crash from a bad request.
      const fitTo =
        Number.isFinite(scale) && scale > 0 && scale !== 1
          ? ({ mode: 'zoom', value: scale } as const)
          : ({ mode: 'original' } as const)
      const installed = await installedFontFiles()
      const resvg = new Resvg(svg, {
        background: themeBackground(options),
        font: { ...fontOption, fontFiles: [...(fontOption.fontFiles ?? []), ...installed] },
        fitTo,
      })
      const png = resvg.render()
      const undrawable = await reportUndrawable(canvas)
      return {
        png: Buffer.from(png.asPng()),
        width: png.width,
        height: png.height,
        undrawable,
        unresolvedFamilies: await reportUnresolvedFamilies(scene),
      }
    },
    async renderSvg(canvas, options) {
      const { svg, scene } = buildSvg(canvas, options, measure)
      return {
        svg,
        undrawable: await reportUndrawable(canvas),
        unresolvedFamilies: await reportUnresolvedFamilies(scene),
      }
    },
  }
}

/**
 * Same discipline as the "Roboto TTF not found" warning above, one level
 * finer: a silent degradation that diverges visually is worth a record. The
 * whole-font case is logged once when the singleton is built; this is the
 * per-character case, and it is logged per render because it depends on the
 * canvas rather than on the install.
 */
async function reportUnresolvedFamilies(scene: Scene): Promise<readonly string[]> {
  const families = unresolvedFamilies(scene, await availableFamilies())
  if (families.length > 0) {
    log.warning(
      { families },
      'export declared font families no loaded face provides; drawn in the fallback',
    )
  }
  return families
}

async function reportUndrawable(canvas: SpatialCanvas): Promise<readonly string[]> {
  const undrawable = await undrawableCharacters(canvas)
  if (undrawable.length > 0) {
    log.warning(
      { count: undrawable.length, characters: undrawable.join('') },
      'export fonts have no glyph for some characters; they render as tofu',
    )
  }
  return undrawable
}

// Pre-warm the singleton during daemon startup so the first user-facing
// `export_canvas` call does not pay the font-parse + resvg-import cost.
// Errors are swallowed because pre-warming is best-effort: the actual
// export path will still surface a descriptive failure.
//
// This function therefore RESOLVES on failure — a caller's `.catch` never
// runs for a build error, so sanitizing the failure is this function's own
// responsibility. Only the failure class is logged: a module-resolution or
// font-read error carries absolute paths in its message and stack, and the
// distribution smoke asserts the daemon never leaks one to stderr.
export async function prewarmHeadlessExporter(): Promise<void> {
  try {
    await getHeadlessExporter()
  } catch (err) {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined
    const name = err instanceof Error ? err.name : 'unknown'
    log.warning({ reason: code ? `${name}(${code})` : name }, 'pre-warm failed')
  }
}

// Public entry — idempotent. The first call resolves a singleton exporter;
// subsequent calls reuse it.
//
// Failure recovery: if buildExporter() rejects (e.g. a font read error
// during prewarm) we drop the cached promise so the next call retries from
// scratch — replaying a rejected promise forever would brick every export
// until the daemon restarts. Storing the in-flight promise (not just the
// resolved value) is what makes concurrent first-callers share one build
// instead of racing separate ones.
function getHeadlessExporter(): Promise<HeadlessExporter> {
  if (!setupPromise) {
    const pending = buildExporter().catch((err) => {
      if (setupPromise === pending) setupPromise = null
      throw err
    })
    setupPromise = pending
  }
  return setupPromise
}

// Named `renderSpatialCanvasTo*` (not `renderSceneTo*`) so a call site never
// reads as, or shadows, canvas-render's own `renderSceneToSvg` export.
export async function renderSpatialCanvasToPng(
  canvas: SpatialCanvas,
  options: HeadlessExportOptions = {},
): Promise<HeadlessExportResult> {
  const exporter = await getHeadlessExporter()
  return exporter.render(canvas, options)
}

export async function renderSpatialCanvasToSvg(
  canvas: SpatialCanvas,
  options: HeadlessExportOptions = {},
): Promise<HeadlessSvgExportResult> {
  const exporter = await getHeadlessExporter()
  return exporter.renderSvg(canvas, options)
}
