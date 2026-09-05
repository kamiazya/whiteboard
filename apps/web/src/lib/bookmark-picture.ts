/**
 * The picture a saved point carries, drawn by the pipeline that matches the
 * document.
 *
 * One place decides this, for the reason `outline-source.ts` exists: the
 * choice used to be no choice at all. Both pages captured
 * `exportScene('png')` whatever they were editing, and `exportScene` renders
 * the SPATIAL canvas — which a markdown document publishes none of. Measured
 * in a real browser: a document with no canvas exports a valid 1x1, 138-byte
 * PNG, against 220x120 / 2295 bytes for a canvas holding one text node. A
 * valid blob is uploaded like any other, so the version row's `hasThumbnail`
 * went true and `VersionTimeline` drew an empty bordered box on every
 * markdown version in daemon mode. Nothing failed; the history just showed
 * blanks.
 *
 * A markdown body goes to the same `markdown-render` request a list row's
 * thumbnail already uses, so a bookmark's picture and the row's picture of
 * the same document are the same picture at two sizes — the property
 * `load-row-render.ts` was written to hold, extended to history.
 *
 * PNG on both arms rather than the SVG the renderer answers with: the
 * daemon's upload route validates the signature and rejects anything else,
 * and one keeper refusing what the other accepts is the difference the
 * versions seam exists to remove.
 */

import { withViewerFontEmbedded } from '@kamiazya/whiteboard-canvas-viewer'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { unhandledKind } from './exhaustive.js'
import { nextLayoutRequestId, sharedLayoutWorkerPool } from './layout-worker-pool.js'
import type { MarkdownRenderResponse } from './layout-worker-protocol.js'
import { rasterizeSvgToPng } from './rasterize-svg.js'

/**
 * The width a markdown body is laid out at for a bookmark's picture. The
 * same fixed width a row's thumbnail uses, so the two agree: a picture that
 * changed with the window would make one document look like two.
 */
const BOOKMARK_LAYOUT_WIDTH = 640

export interface BookmarkPictureSource {
  /** The spatial exporter the page already owns, asked only for a canvas. */
  readonly exportScene: (format: 'png') => Promise<Blob | null>
  /** The markdown body the page is editing, or null when it is editing none. */
  readonly body: string | null
  /**
   * Injected so the markdown arm is assertable without standing up a worker,
   * the way the row loaders inject theirs.
   */
  readonly renderMarkdown?: (body: string, maxWidth: number) => Promise<Blob | null>
}

/**
 * Background priority, not idle: the person just asked for this bookmark and
 * is looking at the row it lands in. Still not interactive — the row appears
 * before its picture does, and the page announces a second time when it
 * arrives.
 */
async function renderMarkdownInPool(body: string, maxWidth: number): Promise<Blob | null> {
  const reply = await sharedLayoutWorkerPool().run<MarkdownRenderResponse>(
    { type: 'markdown-render', id: nextLayoutRequestId(), body, maxWidth },
    'background',
  )
  if (reply.type !== 'markdown-render-done') return null
  // The face has to travel INSIDE the document: an <img>-rendered SVG cannot
  // see the page's fonts, so without this the stored PNG is drawn in whatever
  // system font the browser picks rather than the one the document is read in.
  return await rasterizeSvgToPng(
    await withViewerFontEmbedded(reply.svg),
    Math.max(1, Math.round(reply.bounds.w)),
    Math.max(1, Math.round(reply.bounds.h)),
  )
}

/**
 * Total by contract, like the attach it feeds. The bookmark has already
 * landed by the time a picture is wanted, so a renderer that refuses costs
 * the picture and never the saved point.
 *
 * Around the two PRODUCING arms only, deliberately: an unhandled kind is a
 * programming error and should say so, not become a document that quietly
 * carries no picture.
 */
async function drawnOrNothing(draw: () => Promise<Blob | null>): Promise<Blob | null> {
  try {
    return await draw()
  } catch {
    return null
  }
}

export async function captureBookmarkPicture(
  kind: DocumentKind,
  source: BookmarkPictureSource,
): Promise<Blob | null> {
  switch (kind) {
    case 'spatial':
      return await drawnOrNothing(() => source.exportScene('png'))
    case 'markdown': {
      const body = source.body
      // Nothing laid out is nothing drawn. Answering null here rather than a
      // picture of an empty page is what keeps `hasThumbnail` false, so the
      // row shows no box instead of an empty one.
      if (body === null || body.trim() === '') return null
      return await drawnOrNothing(() =>
        (source.renderMarkdown ?? renderMarkdownInPool)(body, BOOKMARK_LAYOUT_WIDTH),
      )
    }
    default:
      // A new kind names its own pipeline HERE. Falling through to the
      // spatial exporter is exactly what drew the 1x1 above, and it passed
      // every gate this repo has.
      return unhandledKind(kind, 'captureBookmarkPicture')
  }
}
