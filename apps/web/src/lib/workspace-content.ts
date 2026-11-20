/**
 * Where browser-kept document CONTENT is read from, the workspace document
 * being the source of truth.
 *
 * Every reader of a document's content goes through here: the workspace
 * document's tree node is the content record, and there is no other place a
 * document's content is read from. The record is held as an engine lease, so
 * a reader asks for the typed content it needs and never holds a Loro
 * document.
 */
import {
  type ContentWithTags,
  type DocumentContent,
  lease,
  type RecordLease,
} from '@kamiazya/whiteboard-loro-adapter'
import type {
  DocumentKind,
  ExtensionFacets,
  SpatialCanvas,
  StoredCoreFacets,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { BrowserWorkspaceRecords } from './browser-workspace-records.js'

/**
 * The read did not complete, so nothing is known about the document — as
 * opposed to `null`, which is the document's own answer ("no content here").
 * A caller that caches answers must keep the two apart: this one is worth
 * asking again, and caching it as the other is what leaves a preview blank
 * for good.
 */
class DocumentContentUnreadableError extends Error {
  constructor(readonly documentId: string) {
    super(`document content could not be read: ${documentId}`)
    this.name = 'DocumentContentUnreadableError'
  }
}

// The readers are total over their shapes, and a parse would strip fields a
// newer writer added, so these assert the type and check nothing.
const contentShape = z.custom<DocumentContent>()
const canvasShape = z.object({ canvas: z.custom<SpatialCanvas>() })
const facetsShape = z.custom<ExtensionFacets>()
const coreFacetsShape = z.custom<StoredCoreFacets | undefined>()
const bodyShape = z.string()
const entryShape = z.unknown()

/**
 * One document's content as the typed answers readers need, each a read of
 * the record through the lease. `projection` is the document as bytes of its
 * own (content at the root), for a worker that lays a snapshot out.
 */
export interface HeldDocument {
  /** `readDocumentContent`: the half the document's kind names. `kind` is the index row's, for a document that records none. */
  content(kind?: DocumentKind): Promise<DocumentContent>
  /** `readContentWithTags`: the content and a markdown document's frontmatter tags. */
  contentWithTags(kind?: DocumentKind): Promise<ContentWithTags>
  facets(): Promise<ExtensionFacets>
  /** Absent for a spatial document, whose own facets are on its canvas. */
  coreFacets(): Promise<StoredCoreFacets | undefined>
  canvas(): Promise<SpatialCanvas>
  body(): Promise<string>
  projection(): Promise<Uint8Array>
}

function heldDocument(record: RecordLease, documentId: string): HeldDocument {
  const ask = <T>(
    query: 'documentContent' | 'facets' | 'coreFacets' | 'spatialCanvas' | 'markdownBody',
    shape: z.ZodType<T>,
    kind?: DocumentKind,
  ) =>
    lease.read(
      record,
      { query, args: kind === undefined ? { documentId } : { documentId, kind } },
      shape,
    )
  const content = (kind?: DocumentKind) => ask('documentContent', contentShape, kind)
  const coreFacets = () => ask('coreFacets', coreFacetsShape)
  return {
    content,
    // The same two reads `readContentWithTags` makes of one document.
    async contentWithTags(kind) {
      const read = await content(kind)
      if (read.kind !== 'markdown') return { content: read }
      const tags = (await coreFacets())?.tags
      return tags === undefined ? { content: read } : { content: read, tags }
    },
    facets: () => ask('facets', facetsShape),
    coreFacets,
    canvas: async () => (await ask('spatialCanvas', canvasShape)).canvas,
    body: () => ask('markdownBody', bodyShape),
    async projection() {
      const bytes = lease.exportProjection(record, documentId)
      // `withHeldDocument` reads this refusal as absence once the tree agrees.
      if (bytes === null) throw new Error(`the record holds no document ${documentId}`)
      return bytes
    },
  }
}

/**
 * The workspace record as one read found it, AND whether it could be read at
 * all — the distinction `withHeldDocument` needs and its callers must not be
 * given: a workspace that did not open says nothing about a document, so a
 * missing tree must not become "no content" beneath it.
 */
export interface ContentRecord {
  readonly record: RecordLease | null
  readonly read: boolean
}

/**
 * Opens the workspace record once. Total on purpose: a read that failed is
 * `read: false`, never a throw. The caller releases a record that opened.
 *
 * A walk over many documents opens it ONCE and reads each document from it
 * (`withHeldDocument`): the record holds every document, so opening it per
 * document made a cold list quadratic in the workspace.
 */
async function openContentRecord(dbName?: string): Promise<ContentRecord> {
  try {
    // Inside an async body, so the synchronous `getBrowserWorkspaceId` throw
    // that this open must absorb lands in this catch.
    const record = await new BrowserWorkspaceRecords(dbName).open(getBrowserWorkspaceId())
    return { record, read: true }
  } catch {
    return { record: null, read: false }
  }
}

/** A record opened on first use and given back once, however many documents read from it. */
export interface LazyContentRecord {
  open(): Promise<ContentRecord>
  /** Gives the record back if it was ever opened, waiting out an open still in flight. */
  release(): Promise<void>
}

/**
 * `openContentRecord`, deferred to the first document that needs it and
 * shared after — so a walk whose every document is answered from a cache
 * never opens the record at all.
 */
export function lazyContentRecord(dbName?: string): LazyContentRecord {
  let opened: Promise<ContentRecord> | undefined
  return {
    open() {
      opened ??= openContentRecord(dbName)
      return opened
    },
    async release() {
      ;(await opened)?.record?.release()
    },
  }
}

/**
 * `use` over one document of a record the caller already opened, or null when
 * the workspace tree does not HOLD the document. A tree that could not be
 * read is the unreadable answer, never `null`.
 *
 * A read that fails is told apart from an absent document only when it fails:
 * the hot path is the one read, and the record is asked whether it holds the
 * document only to explain a refusal. A refusal about a document the tree
 * holds (a retired stored shape, say) is the caller's to see unchanged.
 */
export async function withHeldDocument<T>(
  content: ContentRecord,
  documentId: string,
  use: (held: HeldDocument) => Promise<T>,
): Promise<T | null> {
  if (!content.read) throw new DocumentContentUnreadableError(documentId)
  if (content.record === null) return null
  try {
    return await use(heldDocument(content.record, documentId))
  } catch (err) {
    if (!(await tree(content.record, documentId))) return null
    throw err
  }
}

async function tree(record: RecordLease, documentId: string): Promise<boolean> {
  try {
    const entry = await lease.read(
      record,
      { query: 'workspaceDocumentEntry', args: { documentId } },
      entryShape,
    )
    return entry !== null
  } catch {
    // A tree that cannot answer holds nothing the caller could read.
    return true
  }
}

/**
 * `use` over a document's CURRENT content, or null when the workspace tree
 * does not HOLD it. The record is opened for this one read and given back.
 *
 * The ONE read for a browser-kept document nothing has open: the files
 * source, an embed and the reference graph all come through here, so what
 * "current" means is decided once.
 *
 * A read that did not COMPLETE is a different answer and propagates as
 * `DocumentContentUnreadableError`, rather than being folded into "no
 * content": every caller reads that as "this document has no content", and
 * the prefetch caches it as terminal, so ONE transient IndexedDB failure
 * would blank a body's embed for the life of the page — with nothing logged,
 * because the catch would be silent.
 */
export async function loadDocument<T>(
  documentId: string,
  use: (held: HeldDocument) => Promise<T>,
  options: { readonly dbName?: string } = {},
): Promise<T | null> {
  const content = await openContentRecord(options.dbName)
  try {
    return await withHeldDocument(content, documentId, use)
  } finally {
    content.record?.release()
  }
}
