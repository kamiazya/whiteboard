import {
  lease,
  type RecordLease,
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
import { SnapshotNotFoundError, withEngineTrapReported } from './document-io.js'
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
  /** Gives the engine's copy back. Releasing twice is one release. */
  release(): void
}

function sessionOver(
  held: RecordLease,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
): DocumentSession {
  return {
    workspaceId,
    documentId,
    read: (query, shape) => readRestoringRefusal(held, query, shape),
    release: () => held.release(),
  }
}

/**
 * The engine answers a reader's refusal as its class NAME, so the class a
 * caller maps to a status is gone by the time it reaches the tool. A retired
 * stored shape is the refusal every content read can raise, and the engine can
 * name the shape it found, so the typed error is rebuilt from that answer.
 */
async function readRestoringRefusal<T>(
  held: RecordLease,
  query: wire.Query,
  shape: Shape<T>,
): Promise<T> {
  try {
    return await lease.read(held, query, shape)
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'RetiredStoredShapeError') throw err
    const found = await lease.read(held, { query: 'retiredStoredShape' }, foundShape)
    throw new RetiredStoredShapeError(found ?? UNNAMED_RETIRED_SHAPE)
  }
}

// A refusal only the index row's kind can raise (a markdown body held as a
// canvas text node, on a document that records no kind) is one the question
// above, which has no kind to ask with, cannot name.
const UNNAMED_RETIRED_SHAPE = 'a markdown body stored as a canvas text node'

const foundShape = z.string().nullable()

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
    return sessionOver(lease.ownedLease(engine, handle), workspaceId, documentId)
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
  return openOver(workspaceId, documentId, bytes)
}

/** Opens a saved document, or an empty one when none was saved yet. */
async function openOrCreateDocument(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  documentId: DocumentId,
): Promise<DocumentSession> {
  return openOver(workspaceId, documentId, await storedBytes(deps, workspaceId, documentId))
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
