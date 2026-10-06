/**
 * The picture a person SAVES of a document: a markdown note's laid-out body,
 * and the file either kind's picture becomes.
 *
 * Standalone is the whole difficulty. The screen draws a stored picture
 * through a `blob:` URL, which names memory in THIS page: a saved SVG opened
 * anywhere else, or the `<img>` a PNG is rasterised through, cannot load it.
 * So every page-local picture is turned into bytes inside the file.
 */

import {
  type BoundingBox,
  type ReferenceSeams,
  type RenderedSvgFragment,
  renderSceneToSvg,
  type Scene,
  sceneDocumentBounds,
} from '@kamiazya/whiteboard-canvas-render'
import {
  createBrowserMeasureText,
  withViewerFontEmbedded,
} from '@kamiazya/whiteboard-canvas-viewer'
import { MAX_FILE_UPLOAD_BYTES } from '@kamiazya/whiteboard-daemon-client/api-contracts/files'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { renderDiagramFragment, renderMathFragment } from './markdown-fragment-renderers.js'
import { embedTextInPng } from './png-embed.js'
import { rasterizeSvgToPng } from './rasterize-svg.js'
import { layoutMarkdownScene } from './render-preview.js'
import { themeFacesNamedBy } from './theme-fonts.js'

export type DocumentExportFormat = 'png' | 'svg'

/** A document drawn for saving: the SVG and the box it covers. */
export interface DrawnDocument {
  readonly svg: string
  readonly bounds: BoundingBox
}

/** The async engines behind math blocks and diagram fences. */
interface ExportFragmentLoaders {
  readonly math: (value: string, displayMode: boolean) => Promise<RenderedSvgFragment | undefined>
  readonly diagram: (lang: string, value: string) => Promise<RenderedSvgFragment | undefined>
}

export interface MarkdownExportOptions {
  /** The bundle the preview resolves the body's references and pictures through. */
  readonly references?: ReferenceSeams
  readonly tagLibrary?: TagLibrary
  /** Injection seam for tests; defaults to the real MathJax/mermaid engines. */
  readonly fragments?: ExportFragmentLoaders
}

/**
 * A note is laid out at the page width `wb_scene_render` draws one at, so the
 * web's saved picture and the daemon's of the same note wrap alike.
 */
const MARKDOWN_EXPORT_WIDTH_PX = 720

const DEFAULT_FRAGMENTS: ExportFragmentLoaders = {
  math: renderMathFragment,
  diagram: renderDiagramFragment,
}

/**
 * A markdown note as the preview draws it, as a whole document: the
 * preview's own layout, its math and diagrams included, in the light theme a
 * saved artifact is pinned to.
 */
export async function renderMarkdownForExport(
  body: string,
  options: MarkdownExportOptions = {},
): Promise<DrawnDocument> {
  const scene = await markdownExportScene(body, options)
  const bounds = sceneDocumentBounds(scene)
  return {
    svg: renderSceneToSvg(scene, { width: bounds.w, height: bounds.h, viewBox: bounds }),
    bounds,
  }
}

export interface SavedPictureOptions {
  /**
   * The document's own source, embedded in a PNG (the draw.io pattern) so
   * the image carries what it was drawn from. A thunk, since an SVG never
   * needs it; absent writes the picture alone.
   */
  readonly source?: () => string
  /** Per-picture ceiling on inlined bytes; defaults to the upload limit. */
  readonly maxImageBytes?: number
}

/** The saved file itself; `null` where this environment cannot rasterise. */
export async function savedPicture(
  format: DocumentExportFormat,
  drawn: DrawnDocument,
  options: SavedPictureOptions = {},
): Promise<Blob | null> {
  const svg = await inlinePageLocalImages(drawn.svg, options.maxImageBytes ?? MAX_FILE_UPLOAD_BYTES)
  if (format === 'svg') return new Blob([svg], { type: 'image/svg+xml' })
  // The face has to travel INSIDE the document: an `<img>`-rendered SVG
  // cannot see the page's fonts, so without this the PNG is drawn in
  // whatever system font the browser picks — not the one on screen. The
  // theme's family travels the same way, and only when this picture names
  // it: a held face is megabytes.
  const png = await rasterizeSvgToPng(
    await withViewerFontEmbedded(svg, themeFacesNamedBy(svg)),
    Math.max(1, Math.round(drawn.bounds.w)),
    Math.max(1, Math.round(drawn.bounds.h)),
  )
  if (png === null || options.source === undefined) return png
  const embedded = embedTextInPng(
    new Uint8Array(await png.arrayBuffer()),
    'whiteboard',
    options.source(),
  )
  // Copied into a fresh ArrayBuffer-backed view: Blob's lib.dom typing
  // rejects ArrayBufferLike-backed Uint8Arrays.
  return new Blob([Uint8Array.from(embedded)], { type: 'image/png' })
}

/**
 * A note's scene with its math and diagrams drawn, as the preview draws them.
 *
 * The layout's fragment seams are synchronous and the engines are not, so
 * the first pass only RECORDS what the body asks for — through the seams
 * themselves, so whatever the layout reaches (an embedded note's math too)
 * is asked for — and the second answers from what rendered. A fragment that
 * fails keeps the layout's own fallback, as it does on screen.
 */
async function markdownExportScene(body: string, options: MarkdownExportOptions): Promise<Scene> {
  const base = {
    measure: createBrowserMeasureText(),
    maxWidth: MARKDOWN_EXPORT_WIDTH_PX,
    theme: 'light' as const,
    ...(options.references === undefined ? {} : { references: options.references }),
    ...(options.tagLibrary === undefined ? {} : { tagLibrary: options.tagLibrary }),
  }
  const loaders = options.fragments ?? DEFAULT_FRAGMENTS
  const wanted = new Map<string, () => Promise<RenderedSvgFragment | undefined>>()
  const first = layoutMarkdownScene(body, {
    ...base,
    renderMath: (value, displayMode) => {
      wanted.set(mathKey(value, displayMode), () => loaders.math(value, displayMode))
      return undefined
    },
    renderDiagram: (lang, value) => {
      wanted.set(fenceKey(lang, value), () => loaders.diagram(lang, value))
      return undefined
    },
  })
  if (wanted.size === 0) return first
  const rendered = new Map(
    await Promise.all(
      [...wanted].map(async ([key, load]) => [key, await load().catch(() => undefined)] as const),
    ),
  )
  return layoutMarkdownScene(body, {
    ...base,
    renderMath: (value, displayMode) => rendered.get(mathKey(value, displayMode)),
    renderDiagram: (lang, value) => rendered.get(fenceKey(lang, value)),
  })
}

const mathKey = (value: string, displayMode: boolean) => `math:${displayMode}:${value}`
const fenceKey = (lang: string, value: string) => `fence:${lang}:${value}`

/**
 * The backend emits an `<image href>` verbatim and escapes nothing a blob URL
 * can hold, so the attribute is matched as written.
 */
const PAGE_LOCAL_HREF = /href="(blob:[^"]+)"/g

/**
 * Every page-local picture in an SVG, replaced by its pixels as a PNG
 * `data:` URI. One that cannot be read, or whose encoding is larger than
 * `maxBytes`, is left out of the file — an empty `href` draws nothing, where
 * a dangling one is a broken reference in a file that outlives this page.
 */
async function inlinePageLocalImages(svg: string, maxBytes: number): Promise<string> {
  const urls = [...new Set(Array.from(svg.matchAll(PAGE_LOCAL_HREF), (match) => match[1] ?? ''))]
  if (urls.length === 0) return svg
  const inlined = new Map(
    await Promise.all(urls.map(async (url) => [url, await pixelsOf(url, maxBytes)] as const)),
  )
  return svg.replace(PAGE_LOCAL_HREF, (_, url: string) => `href="${inlined.get(url) ?? ''}"`)
}

/**
 * Read through an image decode, never `fetch`: the app's policy allows
 * `blob:` for `img-src` and not for `connect-src`, so a fetch of the very URL
 * the editor is drawing fails on the deployed page. A decode re-encodes as
 * PNG, which keeps every pixel and drops the original encoding — a photo's
 * file grows, and an animated picture keeps its first frame.
 */
async function pixelsOf(url: string, maxBytes: number): Promise<string | undefined> {
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (context === null || canvas.width === 0 || canvas.height === 0) return undefined
    context.drawImage(image, 0, 0)
    const uri = canvas.toDataURL('image/png')
    // A base64 payload is four characters per three bytes.
    if (!uri.startsWith('data:image/png') || (uri.length * 3) / 4 > maxBytes) return undefined
    return uri
  } catch {
    return undefined
  }
}
