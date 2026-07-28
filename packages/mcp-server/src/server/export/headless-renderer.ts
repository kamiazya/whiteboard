// Render an Excalidraw scene to PNG without an attached browser client.
//
// Pipeline:
//   1. happy-dom provides window / document / SVGElement so @excalidraw/utils
//      can build an SVG DOM tree at module load time.
//   2. @napi-rs/canvas backs HTMLCanvasElement.getContext('2d').measureText()
//      so Excalidraw's truncateText() and getCanvasSize() compute correctly.
//   3. @excalidraw/utils.exportToSvg(scene) returns the SVG element.
//   4. @resvg/resvg-js rasterises the SVG to PNG, with Excalifont woff2
//      decompressed to TTF and passed via fontBuffers.
//
// This module is process-singleton: buildExporter() — invoked lazily by
// getHeadlessExporter() — must run exactly once before @excalidraw/utils
// is imported, because the bundle reads `window.navigator.platform` at
// module-load time.

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { findPackageRoot } from '../../shared/package-root.js'
import { getLogger } from '../log.js'

const log = getLogger('headless-renderer')

import type { ExportToSvgOpts } from '../excalidraw-utils/src/export.js'

let setupPromise: Promise<HeadlessExporter> | null = null

export interface HeadlessExportOptions {
  // exportingFrame: scene id of a frame element. When set, only the frame and
  // its children are rendered (other elements are filtered out).
  frameId?: string
  // padding: extra px around the bounds. Default mirrors browser export (10).
  padding?: number
  // scale: pixel scale factor. 1 = 100%, 2 = retina-equivalent. Default 1.
  scale?: number
  // background: CSS color or 'transparent'. Default '#ffffff' (or dark default
  // when `theme` is 'dark' and no explicit background is supplied).
  background?: string
  // theme: forces light/dark theme on the rendered scene. Sets appState.theme
  // (which Excalidraw uses to pick its dark-mode SVG filter) and supplies a
  // matching default background so dashed/dotted/low-opacity elements survive.
  theme?: 'light' | 'dark'
}

const DARK_DEFAULT_BACKGROUND = '#121212'
const LIGHT_DEFAULT_BACKGROUND = '#ffffff'

export interface HeadlessExportResult {
  png: Buffer
  width: number
  height: number
}

export interface HeadlessSvgExportResult {
  svg: string
}

interface HeadlessExporter {
  render(scene: ExcalidrawScene, options: HeadlessExportOptions): Promise<HeadlessExportResult>
  renderSvg(
    scene: ExcalidrawScene,
    options: HeadlessExportOptions,
  ): Promise<HeadlessSvgExportResult>
}

interface ExcalidrawScene {
  type: 'excalidraw'
  version: number
  source: string
  elements: readonly ExcalidrawElement[]
  appState?: Record<string, unknown>
  files?: Record<string, ExcalidrawFile>
}

interface ExcalidrawElement {
  id: string
  type: string
  frameId?: string | null
  isDeleted?: boolean
  [key: string]: unknown
}

interface ExcalidrawFile {
  mimeType: string
  id: string
  dataURL: string
  created: number
}

// Resolve the bundled Excalifont woff2. Looked up at module init so the
// daemon does not pay the disk hit per export call.
export async function resolveExcalifontTtf(): Promise<Buffer | null> {
  // Fonts are self-hosted flat under dist/web-app/fonts/Excalifont (apps/web's
  // vite config), relative to the package root in both tsx (src) and built (dist)
  // modes. Resolved from the package root rather than a fixed offset so it stays
  // correct even when the bundler hoists this module into a chunk. See package-root.ts.
  const candidates = [
    resolve(findPackageRoot(import.meta.url), 'dist', 'web-app', 'fonts', 'Excalifont'),
  ]
  for (const dir of candidates) {
    try {
      const entries = await readdir(dir)
      const woff2 = entries.find((f) => f.endsWith('.woff2'))
      if (!woff2) continue
      const woff2Buf = await readFile(join(dir, woff2))
      const wawoff2 = (await import('wawoff2')).default
      const ttf = await wawoff2.decompress(woff2Buf)
      return Buffer.from(ttf)
    } catch {}
  }
  return null
}

async function buildExporter(): Promise<HeadlessExporter> {
  // Polyfill globals BEFORE @excalidraw/utils is imported. Node 24+ exposes
  // navigator as a read-only getter, so use defineProperty.
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/' })
  const define = (k: string, v: unknown) =>
    Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true })
  define('window', win)
  define('document', win.document)
  define('navigator', win.navigator)
  define('HTMLElement', win.HTMLElement)
  define('HTMLCanvasElement', win.HTMLCanvasElement)
  define('SVGElement', win.SVGElement)
  define('Image', win.Image)
  // Disable fetch *only* on the happy-dom window so any Excalidraw code
  // that reaches for `window.fetch` to load remote fonts / assets at
  // render time fails fast. Crucially we do NOT touch `globalThis.fetch`
  // — that is the same fetch used by DaemonClient.request and
  // ensureDaemon's ping, and overwriting it would break every HTTP call
  // across the daemon after the first headless export.
  Object.defineProperty(win, 'fetch', {
    value: async () => {
      throw new Error('fetch is disabled in headless-renderer')
    },
    writable: true,
    configurable: true,
  })
  define('devicePixelRatio', 1)
  define('location', win.location)
  define('crypto', win.crypto ?? globalThis.crypto)
  define(
    'FontFace',
    class {
      load() {
        return Promise.resolve(this)
      }
    },
  )

  // Node-canvas-shaped polyfill: enough for ctx.measureText() which is what
  // Excalidraw's truncateText() and getCanvasSize() need. happy-dom's
  // HTMLCanvasElement type expects a richer return shape than @napi-rs/canvas
  // exposes; treat the napi backing canvas as opaque to skirt that mismatch.
  const napiModule = (await import('@napi-rs/canvas')) as unknown as {
    createCanvas(width: number, height: number): { getContext(kind: '2d'): unknown }
  }
  type PolyfillThis = {
    width?: number
    height?: number
    __nc?: { getContext(kind: '2d'): unknown }
  }
  const proto = (
    globalThis as unknown as { HTMLCanvasElement: { prototype: Record<string, unknown> } }
  ).HTMLCanvasElement.prototype
  proto.getContext = function (this: PolyfillThis, type: string): unknown {
    if (type !== '2d') return null
    if (!this.__nc) this.__nc = napiModule.createCanvas(this.width || 300, this.height || 150)
    return this.__nc.getContext('2d')
  }

  // Vendored facade for @excalidraw/utils. See ../excalidraw-utils/README.md
  // for the provenance story (we own this thin re-export so callers can swap
  // the dep in one place when upstream stabilises).
  const { exportToSvg } = await import('../excalidraw-utils/src/export.js')
  const { Resvg } = await import('@resvg/resvg-js')
  const excalifontTtf = await resolveExcalifontTtf()
  if (!excalifontTtf) {
    // Silent system-font fallback would mask a regression that diverges
    // visually from the browser export, so log it once when the singleton
    // is built. Production daemons typically run with the bundled woff2.
    log.warning('Excalifont woff2 not found; rendering will fall back to system fonts.')
  }
  // Skip resvg's system-font scan when we have Excalifont in hand. The scan
  // dominates first-call latency (~1s+) and we never need any other family
  // in the SVGs Excalidraw produces.
  const fontOption = excalifontTtf
    ? { fontBuffers: [excalifontTtf], loadSystemFonts: false, defaultFontFamily: 'Excalifont' }
    : { loadSystemFonts: true }

  // Shared by render() and renderSvg(): filters elements to a frame and
  // builds the SVGSVGElement Excalidraw's own export utility produces. The
  // PNG path rasterises this via resvg; the SVG path serialises it directly.
  async function buildSvgElement(scene: ExcalidrawScene, options: HeadlessExportOptions) {
    const frameId = options.frameId
    const elements = frameId
      ? scene.elements.filter((e) => e.id === frameId || e.frameId === frameId)
      : scene.elements
    // Compose the appState passed to Excalidraw. When the caller forces a
    // theme we override the scene's recorded theme/background so the same
    // canvas can be exported under both light and dark for comparison.
    const themedAppState =
      options.theme !== undefined
        ? {
            ...(scene.appState ?? {}),
            theme: options.theme,
            viewBackgroundColor:
              options.theme === 'dark' ? DARK_DEFAULT_BACKGROUND : LIGHT_DEFAULT_BACKGROUND,
          }
        : scene.appState
    return exportToSvg({
      elements: elements as unknown as ExportToSvgOpts['elements'],
      appState: themedAppState as ExportToSvgOpts['appState'],
      files: (scene.files ?? null) as ExportToSvgOpts['files'],
      exportPadding: options.padding,
    })
  }

  return {
    async render(scene, options) {
      const svg = await buildSvgElement(scene, options)
      const themeBackground =
        options.theme === 'dark' ? DARK_DEFAULT_BACKGROUND : LIGHT_DEFAULT_BACKGROUND
      const resvg = new Resvg(svg.outerHTML, {
        background: options.background ?? themeBackground,
        font: fontOption,
        fitTo:
          options.scale && options.scale !== 1
            ? { mode: 'zoom', value: options.scale }
            : { mode: 'original' },
      })
      const png = resvg.render()
      return {
        png: Buffer.from(png.asPng()),
        width: png.width,
        height: png.height,
      }
    },
    async renderSvg(scene, options) {
      // Vector output is resolution-independent, so `scale`/`background`
      // (raster-only concerns handled by resvg above) do not apply here.
      const svg = await buildSvgElement(scene, options)
      return { svg: svg.outerHTML }
    },
  }
}

// Pre-warm the singleton during daemon startup so the first user-facing
// `export_canvas` (format:png) call does not pay the jsdom + canvas + resvg + woff2 cost.
// Errors are swallowed because pre-warming is best-effort: the actual export
// path will still surface a descriptive failure.
export async function prewarmHeadlessExporter(): Promise<void> {
  try {
    await getHeadlessExporter()
  } catch (err) {
    log.warning({ err: err instanceof Error ? err : new Error(String(err)) }, 'pre-warm failed')
  }
}

// Public entry — idempotent. The first call sets up DOM + canvas globals and
// resolves a singleton exporter; subsequent calls reuse it.
//
// Failure recovery: if buildExporter() rejects (e.g. an Excalifont read
// error during prewarm) we drop the cached promise so the next call
// retries from scratch — replaying a rejected promise forever would
// brick every export until the daemon restarts.
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

export async function renderSceneToPng(
  scene: ExcalidrawScene,
  options: HeadlessExportOptions = {},
): Promise<HeadlessExportResult> {
  const exporter = await getHeadlessExporter()
  return exporter.render(scene, options)
}

export async function renderSceneToSvg(
  scene: ExcalidrawScene,
  options: HeadlessExportOptions = {},
): Promise<HeadlessSvgExportResult> {
  const exporter = await getHeadlessExporter()
  return exporter.renderSvg(scene, options)
}
