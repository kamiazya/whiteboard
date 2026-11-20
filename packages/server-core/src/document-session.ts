import {
  type CrdtEngine,
  lease,
  randomPeerId,
  type RecordLease,
  sharedCrdtEngine,
} from '@kamiazya/whiteboard-loro-adapter'
import { bytesToBase64, type documentEngine as wire, type DocumentId } from '@kamiazya/whiteboard-model'
import { reassembleSnapshot } from '@kamiazya/whiteboard-ports'
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
  readonly workspaceId: string
  readonly documentId: string
  /** One named read, answered as the value the reader produced. */
  read<T>(query: wire.Query, shape: Shape<T>): Promise<T>
  /** Gives the engine's copy back. Releasing twice is one release. */
  release(): void
}

function sessionOver(
  engine: CrdtEngine,
  held: RecordLease,
  workspaceId: string,
  documentId: string,
): DocumentSession {
  return {
    workspaceId,
    documentId,
    read: (query, shape) => lease.read(held, query, shape),
    release: () => held.release(),
  }
}

async function storedBytes(
  deps: ServerDeps,
  workspaceId: string,
  documentId: DocumentId,
): Promise<Uint8Array | null> {
  const docRef = { kind: 'document' as const, workspaceId, documentId }
  const existing = await withEngineTrapReported(workspaceId, documentId, 'loading', () =>
    deps.documentStore.loadSnapshot({ docRef }),
  )
  return existing === null ? null : reassembleSnapshot(existing.manifest, existing.chunks)
}

function openOver(
  workspaceId: string,
  documentId: DocumentId,
  bytes: Uint8Array | null,
): Promise<DocumentSession> {
  const engine = sharedCrdtEngine()
  return withEngineTrapReported(workspaceId, documentId, 'loading', () => {
    const { handle } = engine.open({
      peer: randomPeerId(),
      ...(bytes === null ? {} : { bytes: bytesToBase64(bytes) }),
    })
    return sessionOver(engine, lease.ownedLease(engine, handle), workspaceId, documentId)
  })
}

/**
 * Opens a saved document, refusing with `SnapshotNotFoundError` when none was
 * saved: a tool that targets an existing element has nothing to work on in a
 * document that never existed.
 */
export async function openDocument(
  deps: ServerDeps,
  workspaceId: string,
  documentId: DocumentId,
): Promise<DocumentSession> {
  const bytes = await storedBytes(deps, workspaceId, documentId)
  if (bytes === null) throw new SnapshotNotFoundError(documentId)
  return openOver(workspaceId, documentId, bytes)
}

/** Opens a saved document, or an empty one when none was saved yet. */
export async function openOrCreateDocument(
  deps: ServerDeps,
  workspaceId: string,
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
  workspaceId: string,
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
