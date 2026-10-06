/**
 * Renders one document to SVG, for a row's thumbnail and for the preview
 * beside it.
 *
 * Both panes show the same picture at two sizes, so both come from here.
 * The alternative — boxes in the list and a render in the preview — is what
 * made a row's icon and its preview disagree about what a document looks
 * like, and a thumbnail that is not a small version of the thing is not a
 * thumbnail.
 *
 * Kind decides only which read supplies the content: markdown by id from the
 * OKF route, spatial by PATH from the snapshot route. Both then go to the
 * shared worker pool at background priority — a thumbnail is never what
 * someone is waiting on.
 *
 * Neither is decoded here. A spatial document's snapshot travels to the
 * worker as bytes, so this thread's share of a thumbnail is the read and
 * nothing else: decoding cost 1.20ms at 12 nodes, 2.60ms at 40 and 4.60ms at
 * 120, and handing the bytes over costs nothing measurable. What that buys
 * is not a faster picture but a thread that is free while one is drawn.
 *
 * Total by contract. Every failure answers `null` and the row keeps its kind
 * icon: a list that cannot draw a miniature is a plainer list, a list that
 * throws is a broken screen.
 *
 * Every answer goes through the render broker (ADR-0027), which is why the
 * preview pane beside a row does not redraw what the row just drew: both
 * ask for the same key, and the second one joins the first rather than
 * starting a second render.
 */

import type { BoundingBox } from '@kamiazya/whiteboard-canvas-render'
import type { DocumentKind } from '@kamiazya/whiteboard-model'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { unhandledKind } from '../../lib/exhaustive.js'
import type { WorkspaceFilesSource } from '../../lib/files-source.js'
import { nextLayoutRequestId, sharedLayoutWorkerPool } from '../../lib/layout-worker-pool.js'
import type { LayoutResponse, MarkdownRenderResponse } from '../../lib/layout-worker-protocol.js'
import type { RenderBroker } from '../../lib/render-broker.js'
import { cacheKeyFor, renderKeyOf, tagLibraryKey } from '../../lib/render-key.js'
import type { ResolvedTheme } from '../../lib/theme.js'
import { loadThemeFontFromSource, themeFacesKey } from '../../lib/theme-fonts.js'
import { ROW_LAYOUT_WIDTH } from './row-layout-width.js'

export interface DocumentRender {
  readonly svg: string
  /** What the SVG's viewBox covers, so a caller can fit it to any box. */
  readonly bounds: BoundingBox
}

export interface RowRenderDeps {
  readonly source: WorkspaceFilesSource
  /** Spatial rendering resolves its palette from this; markdown takes its ink from CSS. */
  readonly theme: ResolvedTheme
  /**
   * Answers from the memo, joins a render already in flight for the same key,
   * and otherwise runs the pipeline below exactly once.
   */
  readonly broker: RenderBroker
  /**
   * Both renders are injected like the reads above, so the branch that
   * actually produces a picture is assertable without standing up a worker.
   */
  readonly renderMarkdown?: (
    body: string,
    maxWidth: number,
    cacheKey?: string,
  ) => Promise<DocumentRender | null>
  /**
   * Takes the stored SNAPSHOT — the worker decodes it, not this thread — and
   * the workspace's tag library, whose declared colours the board is drawn in.
   */
  readonly renderSpatial?: (
    snapshot: Uint8Array,
    theme: ResolvedTheme,
    tagLibrary: TagLibrary,
    cacheKey?: string,
  ) => Promise<DocumentRender | null>
}

// `cacheKey` rides ON the request rather than being applied around the call:
// the persistent tier lives in the worker, beside the bytes, so reading it
// costs nothing on the thread that asked (ADR-0027 decision 5).
async function renderMarkdownInPool(
  body: string,
  maxWidth: number,
  cacheKey?: string,
): Promise<DocumentRender | null> {
  const reply = await sharedLayoutWorkerPool().run<MarkdownRenderResponse>(
    {
      type: 'markdown-render',
      id: nextLayoutRequestId(),
      body,
      maxWidth,
      ...(cacheKey === undefined ? {} : { cacheKey }),
    },
    'background',
  )
  return reply.type === 'markdown-render-done' ? { svg: reply.svg, bounds: reply.bounds } : null
}

async function renderSpatialInPool(
  snapshot: Uint8Array,
  theme: ResolvedTheme,
  tagLibrary: TagLibrary,
  cacheKey?: string,
): Promise<DocumentRender | null> {
  const reply = await sharedLayoutWorkerPool().run<LayoutResponse>(
    {
      type: 'layout',
      id: nextLayoutRequestId(),
      snapshot,
      theme,
      tagLibrary,
      ...(cacheKey === undefined ? {} : { cacheKey }),
    },
    'background',
  )
  if (reply.type !== 'laid-out') return null
  // The fetch is on USE, and this is the moment of use: a list surface hands
  // over stored bytes and never decodes the canvas, so the worker's reply is
  // the first thing on this thread that knows which family the board's theme
  // names. Not awaited — the picture the worker just drew is the answer, and
  // the face lands in every realm at once (`attachThemeFaces`) and bumps the
  // fonts generation, which is what asks the surfaces to draw again. A folder
  // of fifty boards naming one theme fetches once: the loader refuses a face
  // that is held or already in flight.
  for (const family of reply.fontsMissing ?? []) void loadThemeFontFromSource(family)
  return { svg: reply.svg, bounds: reply.bounds }
}

/**
 * The kind the pipeline will actually take, which is what the key has to
 * agree with. `kind` is optional on a row, and an entry without one is read
 * as spatial below — so the key must say spatial too. Deriving both from
 * here is not tidiness: a key that said `markdown` for a spatially rendered
 * document would drop the theme axis, and one entry would then serve a light
 * and a dark render of the same board.
 */
function renderedKind(document: WorkspaceDocumentEntry): DocumentKind {
  // A row that does not say its kind is read as spatial, which is what the
  // pipeline below does with it. The switch is what makes a NEW kind a
  // compile error here rather than another silent spatial: being drawn by
  // the wrong pipeline is a picture of the wrong thing, not a missing one.
  const kind = document.kind ?? 'spatial'
  switch (kind) {
    case 'markdown':
      return 'markdown'
    case 'spatial':
      return 'spatial'
    default:
      return unhandledKind(kind, 'renderedKind')
  }
}

interface KeyedLibrary {
  readonly library: TagLibrary
  /** `tagLibraryKey(library)`, computed once beside it. */
  readonly key: string
}

/**
 * The workspace's tag library, or `{}` when the keeper cannot answer: a
 * library that will not read leaves the boxes in their own colours, which
 * is a plainer picture and never a missing one.
 */
async function readKeyedLibrary(source: WorkspaceFilesSource): Promise<KeyedLibrary> {
  // Remembered for the loader's life, so a rejection here would cost every
  // board its picture rather than its colours.
  try {
    const library = (await source.readTagLibrary?.()) ?? {}
    return { library, key: await tagLibraryKey(library) }
  } catch {
    return { library: {}, key: '' }
  }
}

/**
 * Once per loader, which is once per panel and theme: the library is the
 * workspace's, so a folder of fifty boards is one read, and it changes when
 * someone edits the `tags` document — rare, and picked up the next time the
 * panel is built, as the editor picks it up when a board opens.
 */
function libraryReader(source: WorkspaceFilesSource): () => Promise<KeyedLibrary> {
  let keyed: Promise<KeyedLibrary> | undefined
  return () => {
    keyed ??= readKeyedLibrary(source)
    return keyed
  }
}

async function produce(
  deps: RowRenderDeps,
  document: WorkspaceDocumentEntry,
  tagLibrary: TagLibrary,
  cacheKey: string | undefined,
): Promise<DocumentRender | null> {
  if (renderedKind(document) === 'markdown') {
    const { body } = await deps.source.loadMarkdown(document)
    if (body.trim() === '') return null
    return await (deps.renderMarkdown ?? renderMarkdownInPool)(body, ROW_LAYOUT_WIDTH, cacheKey)
  }

  const snapshot = await deps.source.loadSpatialSnapshot(document)
  return await (deps.renderSpatial ?? renderSpatialInPool)(
    snapshot,
    deps.theme,
    tagLibrary,
    cacheKey,
  )
}

export function createRowRenderLoader(deps: RowRenderDeps) {
  const libraryOnce = libraryReader(deps.source)

  return async (document: WorkspaceDocumentEntry): Promise<DocumentRender | null> => {
    // The catch stays OUTSIDE the broker: a rejection must not be remembered
    // as an answer, so the broker is allowed to see it and forget the entry,
    // and the totality this loader promises is restored here.
    try {
      const kind = renderedKind(document)
      // Awaited before the key is built, because the key names the library.
      // Markdown draws no box a declaration could colour, so it neither
      // waits for the library nor is keyed by it.
      const { library, key: libraryKey } =
        kind === 'spatial' ? await libraryOnce() : { library: {}, key: '' }
      const key = renderKeyOf(
        {
          documentId: document.documentId,
          kind,
          // The CONTENT's identity, never the stamp: a merge can change the
          // one and leave the other where it was (see document-entry.ts).
          ...(document.contentDigest === undefined ? {} : { state: document.contentDigest }),
        },
        deps.theme,
        // Read at the moment the key is built, never held on the loader: a
        // surface that asks again after a face landed must produce a
        // different key, and the loader outlives the landing.
        themeFacesKey(),
        libraryKey,
      )
      return await deps.broker.render(key, () => produce(deps, document, library, cacheKeyFor(key)))
    } catch {
      return null
    }
  }
}
