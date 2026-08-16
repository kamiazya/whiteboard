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
import { parseMarkdownBody } from '@kamiazya/whiteboard-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'

import { getLogger } from '../log.js'
import { EXPORT_FONT_FAMILY, resolveExportFontFile } from './export-font.js'
import { createOpentypeMeasureText } from './measure-text.js'

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
}

export interface HeadlessSvgExportResult {
  svg: string
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
    parseBody: parseMarkdownBody,
    appearance: EXPORT_APPEARANCE_BY_MODE[mode],
    onDegrade,
  })
}

function buildSvg(
  canvas: SpatialCanvas,
  options: HeadlessExportOptions,
  measure: MeasureText,
): string {
  // `theme` is an explicit per-request argument — the invariant that a
  // user's ambient UI theme never changes exported bytes is untouched.
  const mode: ExportThemeMode = options.theme === 'dark' ? 'dark' : 'light'
  const scene = buildSpatialScene(canvas, measure, mode)
  return renderSceneToSvgString(scene, {
    padding: options.padding ?? DEFAULT_PADDING_PX,
    background: themeBackground(options),
    // Dark node chrome uses transparent fills, so body runs sit directly on
    // the dark background — the root-level inheritable fill is what keeps
    // them legible. Light stays byte-identical (no root fill).
    ...(mode === 'dark' ? { textFill: SPATIAL_DARK_PALETTE.labelFill } : {}),
  })
}

async function buildExporter(): Promise<HeadlessExporter> {
  const measure = await createOpentypeMeasureText()
  const { Resvg } = await import('@resvg/resvg-js')
  const fontPath = await resolveExportFontFile()
  if (!fontPath) {
    // Silent system-font fallback would mask a regression that diverges
    // visually across machines, so log it once when the singleton is
    // built. Production daemons typically run with the bundled TTF.
    log.warning('Roboto TTF not found; rendering will fall back to system fonts.')
  }
  // Skip resvg's system-font scan when we have the vendored font in hand.
  // The scan dominates first-call latency (~1s+) and no other family
  // appears in the SVG canvas-render produces.
  const fontOption = fontPath
    ? { fontFiles: [fontPath], loadSystemFonts: false, defaultFontFamily: EXPORT_FONT_FAMILY }
    : { loadSystemFonts: true }

  return {
    async render(canvas, options) {
      const svg = buildSvg(canvas, options, measure)
      const scale = options.scale ?? 1
      // A non-finite, zero, or negative scale is not a valid zoom factor for
      // resvg (it throws on a zero/negative target size) — degrade to an
      // unscaled render rather than propagating a crash from a bad request.
      const fitTo =
        Number.isFinite(scale) && scale > 0 && scale !== 1
          ? ({ mode: 'zoom', value: scale } as const)
          : ({ mode: 'original' } as const)
      const resvg = new Resvg(svg, {
        background: themeBackground(options),
        font: fontOption,
        fitTo,
      })
      const png = resvg.render()
      return {
        png: Buffer.from(png.asPng()),
        width: png.width,
        height: png.height,
      }
    },
    async renderSvg(canvas, options) {
      return { svg: buildSvg(canvas, options, measure) }
    },
  }
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
