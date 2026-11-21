import {
  lease,
  type RecordLease,
  RetiredCommentPlaneError,
  RetiredStoredShapeError,
  randomPeerId,
  sharedCrdtEngine,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  bytesToBase64,
  type DocumentId,
  type WorkspaceId,
  type documentEngine as wire,
} from '@kamiazya/whiteboard-model'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { z } from 'zod'
import {
  announceDocumentWritten,
  SnapshotNotFoundError,
  storeSnapshot,
  withEngineTrapReported,
} from './document-io.js'
import type { ServerDeps } from './server-deps.js'

/** What a parser must offer to type an engine answer; the engine's own `AnswerShape`. */
type Shape<T> = { parse(value: unknown): T }

/**
 * One stored document held open on the shared CRDT engine for the length of a
 * tool call. The tool asks named questions of it and gives it back; nothing
 * about the document outlives the call.
 */
export interface DocumentSession {
  readonly workspaceId: WorkspaceId
  readonly documentId: DocumentId
  /** One named read, answered as the value the reader produced. */
  read<T>(query: wire.Query, shape: Shape<T>): Promise<T>
  /**
   * Applies the batch to the engine's copy as one commit, unjudged: the store
   * a save reaches judges what it is handed, as it did the direct writes. A
   * writer that throws leaves the copy as it was and the error is the
   * writer's own. Nothing reaches the store until `save`.
   */
  write(batch: wire.Write[]): void
  /**
   * Stores the copy as it now stands and tells the document-written observer.
   * The store has the whole document or nothing; the observer's failure is
   * logged and never undoes the save.
   */
  save(): Promise<void>
  /** Gives the engine's copy back. Releasing twice is one release. */
  release(): void
}

function sessionOver(
  deps: ServerDeps,
  held: RecordLease,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
): DocumentSession {
  return {
    workspaceId,
    documentId,
    read: (query, shape) =>
      readRestoringRefusal({ read: (q, s) => lease.read(held, q, s) }, query, shape),
    write(batch) {
      if (batch.length > 0) lease.write(held, batch, { judge: 'none' })
    },
    async save() {
      await withEngineTrapReported(workspaceId, documentId, 'saving', () =>
        storeSnapshot(
          deps,
          { workspaceId, documentId },
          lease.exportSnapshot(held),
          lease.versionOf(held).encoded,
        ),
      )
      await announceDocumentWritten(deps, workspaceId, documentId)
    },
    release: () => held.release(),
  }
}

/** What answers a named read: a document session's lease, or a record session. */
export interface NamedReader {
  read<T>(query: wire.Query, shape: Shape<T>): Promise<T>
}

/**
 * The engine answers a reader's refusal as its class NAME, so the class a
 * caller maps to a status is gone by the time it reaches the tool. The two
 * refusals every content read can raise are rebuilt from what the engine can
 * still be asked: the retired shape it found, and the rows the retired
 * comment plane holds.
 */
export async function readRestoringRefusal<T>(
  reader: NamedReader,
  query: wire.Query,
  shape: Shape<T>,
): Promise<T> {
  try {
    return await reader.read(query, shape)
  } catch (err) {
    if (!(err instanceof Error)) throw err
    if (err.name === 'RetiredStoredShapeError') {
      const found = await reader.read({ query: 'retiredStoredShape', args: query.args }, foundShape)
      throw new RetiredStoredShapeError(found ?? UNNAMED_RETIRED_SHAPE)
    }
    if (err.name === 'RetiredCommentPlaneError') {
      const rows = await reader.read({ query: 'retiredCommentRows', args: query.args }, rowsShape)
      if (rows > 0) throw new RetiredCommentPlaneError(rows)
    }
    throw err
  }
}

// A refusal only the index row's kind can raise (a markdown body held as a
// canvas text node, on a document that records no kind) is one the question
// above, which has no kind to ask with, cannot name.
const UNNAMED_RETIRED_SHAPE = 'a markdown body stored as a canvas text node'

const foundShape = z.string().nullable()
const rowsShape = z.number()

async function storedBytes(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
): Promise<Uint8Array | null> {
  const docRef = { kind: 'document' as const, workspaceId, documentId }
  const existing = await withEngineTrapReported(workspaceId, documentId, 'loading', () =>
    deps.documentStore.loadSnapshot({ docRef }),
  )
  return existing === null ? null : reassembleSnapshot(existing.manifest, existing.chunks)
}

function openOver(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  bytes: Uint8Array | null,
): Promise<DocumentSession> {
  const engine = sharedCrdtEngine()
  return withEngineTrapReported(workspaceId, documentId, 'loading', () => {
    const { handle } = engine.open({
      peer: randomPeerId(),
      ...(bytes === null ? {} : { bytes: bytesToBase64(bytes) }),
    })
    return sessionOver(deps, lease.ownedLease(engine, handle), workspaceId, documentId)
  })
}

/**
 * Opens a saved document, refusing with `SnapshotNotFoundError` when none was
 * saved: a tool that targets an existing element has nothing to work on in a
 * document that never existed.
 */
export async function openDocument(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
): Promise<DocumentSession> {
  const bytes = await storedBytes(deps, workspaceId, documentId)
  if (bytes === null) throw new SnapshotNotFoundError(documentId)
  return openOver(deps, workspaceId, documentId, bytes)
}

/** Opens a saved document, or an empty one when none was saved yet. */
async function openOrCreateDocument(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
): Promise<DocumentSession> {
  return openOver(deps, workspaceId, documentId, await storedBytes(deps, workspaceId, documentId))
}

/**
 * Runs `work` on a document and gives it back whether `work` returns, rejects
 * or throws, so a tool cannot leak the engine's copy on a refusal path.
 */
export async function withDocument<T>(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  work: (session: DocumentSession) => Promise<T> | T,
  options?: { readonly create?: boolean },
): Promise<T> {
  const session = await (options?.create === true ? openOrCreateDocument : openDocument)(
    deps,
    workspaceId,
    documentId,
  )
  try {
    return await work(session)
  } finally {
    session.release()
  }
}

/**
 * Runs `work` on an empty document that is not read from the store, for a
 * document that is being BORN: nothing stored is merged into it, and its save
 * replaces whatever a store held under the id.
 */
export async function withNewDocument<T>(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
  work: (session: DocumentSession) => Promise<T> | T,
): Promise<T> {
  const session = await openOver(deps, workspaceId, documentId, null)
  try {
    return await work(session)
  } finally {
    session.release()
  }
}
