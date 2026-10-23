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
import { type FragmentLoaders, layoutWithFragments } from './fragment-requests.js'
import { FRAGMENT_ENGINES } from './markdown-fragment-renderers.js'
import { embedTextInPng } from './png-embed.js'
import { rasterizeSvgToPng } from './rasterize-svg.js'
import { layoutMarkdownScene } from './render-preview.js'
import { backgroundOf, type PictureExportOptions } from './spatial/picture-options.js'
import { exportEnvelope } from './spatial/scene-render-core.js'
import { themeFacesNamedBy } from './theme-fonts.js'

/** The two pictures a document can be saved as. */
export type PictureFormat = 'png' | 'svg'

/**
 * What ⋮ → Export… can save: a picture, or the document's own file (`md` for
 * a note, `canvas` for a board).
 */
export type DocumentExportFormat = PictureFormat | CommentedPictureFormat | 'md' | 'canvas'

/**
 * A board's picture with its annotation layer drawn in. The plain pictures
 * leave it out: a file handed to someone else should not carry the
 * authors' review conversation unless they chose it.
 */
type CommentedPictureFormat = 'png-comments' | 'svg-comments'

/** Whether a picture format asks for the annotation layer to be drawn in. */
export function isCommentedPicture(format: PictureFormat | CommentedPictureFormat): boolean {
  return format === 'png-comments' || format === 'svg-comments'
}

/** The picture a commented format saves, or the format itself when it is already plain. */
export function pictureFormatOf(format: PictureFormat | CommentedPictureFormat): PictureFormat {
  return format === 'png-comments' ? 'png' : format === 'svg-comments' ? 'svg' : format
}

/** A document drawn for saving: the SVG and the box it covers. */
export interface DrawnDocument {
  readonly svg: string
  readonly bounds: BoundingBox
  /** PNG pixels per canvas unit it is saved at (default 1); an SVG has none. */
  readonly scale?: number
}

export interface MarkdownExportOptions {
  /** The bundle the preview resolves the body's references and pictures through. */
  readonly references?: ReferenceSeams
  readonly tagLibrary?: TagLibrary
  /** Absent is a transparent 1x picture. */
  readonly picture?: PictureExportOptions
  /** Injection seam for tests; defaults to the real MathJax/mermaid engines. */
  readonly fragments?: FragmentLoaders
}

/**
 * A note is laid out at the page width `wb_scene_render` draws one at, so the
 * web's saved picture and the daemon's of the same note wrap alike.
 */
const MARKDOWN_EXPORT_WIDTH_PX = 720

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
    svg: renderSceneToSvg(scene, exportEnvelope(bounds, backgroundOf(options.picture))),
    bounds,
    ...(options.picture === undefined ? {} : { scale: options.picture.scale }),
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
  format: PictureFormat,
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
    drawn.scale ?? 1,
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
 * A note's scene with its math and diagrams drawn, as the preview draws them:
 * the layout's own record of what it asks for — an embedded note's math too —
 * rendered, then answered.
 */
function markdownExportScene(body: string, options: MarkdownExportOptions): Promise<Scene> {
  const base = {
    measure: createBrowserMeasureText(),
    maxWidth: MARKDOWN_EXPORT_WIDTH_PX,
    theme: 'light' as const,
    ...(options.references === undefined ? {} : { references: options.references }),
    ...(options.tagLibrary === undefined ? {} : { tagLibrary: options.tagLibrary }),
  }
  return layoutWithFragments(
    (seams) => layoutMarkdownScene(body, { ...base, ...seams }),
    options.fragments ?? FRAGMENT_ENGINES,
  )
}

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
