/**
 * Where browser-kept document CONTENT is read from and seeded to, now that
 * the workspace document is the source of truth.
 *
 * Every reader that used to load a per-document Loro record goes through
 * `loadDocumentContent`: the workspace document's tree node answers first
 * (that is where the editor persists), and the legacy per-document record
 * stays as the fallback for a document nothing has folded yet — including
 * jsdom tests whose injected store double is the only storage there is.
 */
import {
  projectWorkspaceDocument,
  resolveWorkspaceDocumentById,
  writeWorkspaceDocumentContent,
} from '@kamiazya/whiteboard-loro-adapter'
import { Loro, type LoroDoc } from 'loro-crdt'
import { BrowserWorkspaceDocs, openWorkspaceOrNull } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { LoroStore, type LoroStoreLike, touchContentTimestamp } from './loro-store.js'

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

/**
 * A document's CURRENT content as a standalone Loro document (a value
 * projection — fresh oplog, current state), or null when neither the
 * workspace tree nor the legacy store HOLDS it.
 *
 * The ONE read for a browser-kept document nothing has open: the files
 * source, a duplicate, an embed and the reference graph all come through
 * here, so what "current" means — tree first, legacy record after — is
 * decided once.
 *
 * A read that did not COMPLETE is a different answer and now propagates as
 * `DocumentContentUnreadableError`. It used to be folded into "no content"
 * twice over — a thrown read was caught here and reported as `not-found`,
 * and the store's own `read-unavailable`, which exists to say "the read
 * failed and this says nothing about the document", fell into the same
 * `!== 'ok'` branch. Every caller above reads that as "this document has no
 * content", and the prefetch caches it as terminal, so ONE transient
 * IndexedDB failure blanked a body's embed for the life of the page — with
 * nothing logged, because the catch was silent.
 *
 * `corrupt-snapshot` / `corrupt-delta` / `unsupported-version` stay `null`:
 * those are verdicts on the stored bytes, so asking again cannot change the
 * answer. Only the one that says nothing about the bytes is retryable.
 */
export async function loadDocumentContent(
  documentId: string,
  options: ProjectOptions = {},
): Promise<LoroDoc | null> {
  return projectDocumentContent(await openContentRecord(options.dbName), documentId, options)
}

interface ProjectOptions {
  /**
   * The legacy per-document store to fall back on. Injected by a surface
   * that was handed one (a page's store double in a test); the default is
   * the real one.
   */
  readonly loro?: LoroStoreLike
  readonly dbName?: string
}

/**
 * The workspace record as one read found it, AND whether it could be read at
 * all — the distinction `projectDocumentContent` needs and its callers must
 * not be given: a workspace that did not open says nothing about a document,
 * so "the legacy row has no record" must not become "no content" beneath it.
 */
export interface ContentRecord {
  readonly workspace: LoroDoc | null
  readonly read: boolean
}

/**
 * Opens the workspace record once. Total on purpose: a read that failed is
 * `read: false`, never a throw.
 *
 * A walk over many documents opens it ONCE and projects each document from
 * that value (`projectDocumentContent`): the record holds every document, so
 * opening it per document made a cold list quadratic in the workspace.
 */
async function openContentRecord(dbName?: string): Promise<ContentRecord> {
  try {
    // Inside an async body, so the synchronous `getBrowserWorkspaceId` throw
    // that `openWorkspaceOrNull` exists to absorb lands in this catch.
    const workspace = await new BrowserWorkspaceDocs(dbName).open(getBrowserWorkspaceId())
    return { workspace, read: true }
  } catch {
    return { workspace: null, read: false }
  }
}

/**
 * `openContentRecord`, deferred to the first document that needs it and
 * shared after — so a walk whose every document is answered from a cache
 * never opens the record at all.
 */
export function lazyContentRecord(dbName?: string): () => Promise<ContentRecord> {
  let opened: Promise<ContentRecord> | undefined
  return () => {
    opened ??= openContentRecord(dbName)
    return opened
  }
}

/**
 * `loadDocumentContent` over a record the caller already opened: the tree's
 * projection first, the legacy record after, with the same verdicts.
 */
export async function projectDocumentContent(
  record: ContentRecord,
  documentId: string,
  options: ProjectOptions = {},
): Promise<LoroDoc | null> {
  const tree = treeProjection(record, documentId)
  if (tree.doc !== null) return tree.doc
  const treeUnread = !tree.read
  const result = await (options.loro ?? new LoroStore(options.dbName)).load(documentId)
  if (result.kind === 'read-unavailable') throw new DocumentContentUnreadableError(documentId)
  if (result.kind !== 'ok') {
    if (treeUnread) throw new DocumentContentUnreadableError(documentId)
    return null
  }
  const doc = new Loro()
  doc.import(result.snapshot)
  for (const delta of result.deltas ?? []) doc.import(delta)
  return doc
}

/** The tree's answer for one document; a projection that throws is a tree that could not be read. */
function treeProjection(
  record: ContentRecord,
  documentId: string,
): { doc: LoroDoc | null; read: boolean } {
  if (!record.read) return { doc: null, read: false }
  try {
    return {
      doc:
        record.workspace === null ? null : projectWorkspaceDocument(record.workspace, documentId),
      read: true,
    }
  } catch {
    return { doc: null, read: false }
  }
}

/**
 * True — after stamping the listing clock — exactly when the tree holds this
 * document, i.e. when its node's containers already ARE the (empty) content
 * record and a create has nothing else to seed.
 */
export async function touchIfWorkspaceBacked(
  documentId: string,
  dbName?: string,
): Promise<boolean> {
  const workspace = await openWorkspaceOrNull(new BrowserWorkspaceDocs(dbName))
  if (workspace === null) return false
  if (resolveWorkspaceDocumentById(workspace, documentId) === null) return false
  await touchContentTimestamp(documentId, dbName)
  return true
}

/**
 * Writes standalone-document bytes INTO an existing tree node (a create
 * seed, a duplicate's copy). Returns false when the workspace record or the
 * node is absent — the caller falls back to the legacy per-document store,
 * which is also what keeps injected test doubles working.
 */
export async function seedWorkspaceDocumentContent(
  documentId: string,
  content: Uint8Array,
  dbName?: string,
): Promise<boolean> {
  const docs = new BrowserWorkspaceDocs(dbName)
  const workspace = await openWorkspaceOrNull(docs)
  if (workspace === null) return false
  const source = new Loro()
  source.import(content)
  if (!writeWorkspaceDocumentContent(workspace, documentId, source)) return false
  await docs.save(getBrowserWorkspaceId(), workspace)
  await touchContentTimestamp(documentId, dbName)
  return true
}
