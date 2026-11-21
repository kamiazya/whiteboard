import { isEngineTrap } from '@kamiazya/whiteboard-loro-adapter'
import { type DocumentId, messageOf } from '@kamiazya/whiteboard-model'
import { chunkSnapshot, DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES } from '@kamiazya/whiteboard-ports'
import { getLogger } from './log.js'
import type { ServerDeps } from './server-deps.js'

const log = getLogger('document-io')

/**
 * Thrown when a document has no saved snapshot. Not a Zod schema — only
 * `.message` crosses the MCP wire via the SDK's existing tool-error path, so
 * this is a plain Error subclass rather than a DTO.
 *
 * It lives beside the loader that raises it, and it is the ONLY class for
 * this condition: read-side and write-side callers alike go through
 * `openDocument`, so `create-server.ts` maps one class to its 404 rather
 * than a list that a new loader could silently grow.
 *
 * Distinct from `WorkspaceDocumentNotFoundError` (the workspace INDEX has no
 * such document) and from ports' own `DocumentNotFoundError` (an operation
 * named a document the index does not hold) — different conditions, and
 * naming this one for the snapshot keeps all three tellable apart.
 */
export class SnapshotNotFoundError extends Error {
  constructor(readonly documentId: string) {
    super(`document has no saved snapshot: ${documentId}`)
    this.name = 'SnapshotNotFoundError'
  }
}

/**
 * Thrown when the CRDT engine aborts while a document is being loaded, saved,
 * or handed a client's update. Nothing from the write was stored. The
 * in-memory copy the engine was working on is unusable from then on — each
 * later call on it traps again — so repeating the same call is not a retry.
 *
 * `subject` names what the engine was working on in words a caller can act
 * on: a document, a document's path, or a whole workspace record. For `doing:
 * 'running'` it is the core's operation (laying out, searching, parsing,
 * writing a facet), and the engine is the Rust core: one error and one
 * refusal code serve both engines, since a caller can do the same about
 * either (nothing).
 *
 * It lives beside the loader that raises it, for the reason
 * `SnapshotNotFoundError` does.
 */
export class DocumentEngineTrapError extends Error {
  constructor(
    public readonly subject: string,
    public readonly doing: 'loading' | 'saving' | 'importing an update into' | 'running',
    cause: unknown,
    /** Whether the engine that trapped is usable again; only a core operation can say it is not. */
    recovered = true,
  ) {
    super(engineTrapMessage(subject, doing, recovered), { cause })
    this.name = 'DocumentEngineTrapError'
  }
}

function engineTrapMessage(
  subject: string,
  doing: DocumentEngineTrapError['doing'],
  recovered: boolean,
): string {
  if (doing !== 'running') {
    return (
      `The CRDT engine aborted while ${doing} ${subject}; nothing from this write was stored. ` +
      `A very large document is the usual trigger. ${DOCUMENT_ENGINE_TRAP_ADVICE[doing]}`
    )
  }
  const advice = recovered ? CORE_TRAP_RECOVERED : CORE_TRAP_UNRECOVERABLE
  return `The Rust core aborted while running ${subject}; nothing from this request was stored. ${advice}`
}

const CORE_TRAP_RECOVERED =
  'The core was reset, so the next request runs on a fresh instance; sending the same input again may abort the same way.'

const CORE_TRAP_UNRECOVERABLE =
  'The core could not be reset and answers every request with this until the daemon restarts.'

/**
 * The code every surface answers `DocumentEngineTrapError` with — `/api/v1`'s
 * refusal table and the sync routes alike — with status 500: a server fault
 * the caller cannot fix by rewording.
 */
export const DOCUMENT_ENGINE_TRAP_CODE = 'document_engine_trap'

const STUCK_UNTIL_RESTART =
  'If the same document fails again, its in-memory copy is unusable until the daemon restarts or the document is deleted.'

const DOCUMENT_ENGINE_TRAP_ADVICE: Readonly<
  Record<Exclude<DocumentEngineTrapError['doing'], 'running'>, string>
> = {
  loading: STUCK_UNTIL_RESTART,
  saving: STUCK_UNTIL_RESTART,
  // Measured on loro-crdt 1.13.6: after one trap, fresh instances in the same
  // process took a 64 Ki-character import and trapped within a millisecond
  // on 128 Ki and larger, so the reload is not promised to work.
  'importing an update into':
    'The in-memory copy was dropped, so the next request reloads what was stored; sending the same update again aborts the same way. After a trap this process may abort on other large writes too, until the daemon restarts.',
}

/**
 * Runs one load or save of a document and answers an engine abort as
 * `DocumentEngineTrapError`, logged at error with the document it was about.
 *
 * Loud at the funnel every document read and write passes through: the
 * engine's own panic text goes to stderr with no document in it, and the bare
 * `unreachable` that would otherwise reach a caller names nothing.
 */
export async function withEngineTrapReported<T>(
  workspaceId: string,
  documentId: string,
  doing: 'loading' | 'saving',
  work: () => Promise<T> | T,
): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (!isEngineTrap(err)) throw err
    log.error('the CRDT engine trapped on a document', {
      workspaceId,
      documentId,
      doing,
      err: messageOf(err),
    })
    throw new DocumentEngineTrapError(`document ${documentId}`, doing, err)
  }
}

/** A document some cache holds, as an engine trap inside a write must report and drop it. */
export interface CachedTarget {
  /** What the engine was working on, in words a caller can act on. */
  readonly subject: string
  /** The log fields that locate it. */
  readonly fields: Record<string, unknown>
  /** Drops the cached instance, so the next read rebuilds it from what was stored. */
  evict(): void
}

/**
 * Runs `work` on a CACHED document, telling an engine trap apart from
 * anything else it throws.
 *
 * A refusal leaves the instance as it was, so it is rethrown untouched and the
 * caller answers it as the client's mistake. A trap poisons the instance for
 * every later call, so `evict` drops whatever cache holds it before the
 * `DocumentEngineTrapError` is raised — the next request then rebuilds from
 * storage instead of the daemon serving a dead copy until it restarts.
 *
 * The one funnel for a cached document's sync writes: the import, the
 * attach that brings a detached document's state up, and the attach after a
 * checkout all run inside it, so none can recover from a trap differently
 * from the others. A load or save goes through `withEngineTrapReported`,
 * which has no cached instance to drop.
 */
export function runEvictingOnEngineTrap<T>(
  target: CachedTarget,
  doing: Exclude<DocumentEngineTrapError['doing'], 'running'>,
  work: () => T,
): T {
  try {
    return work()
  } catch (err) {
    return dropTrapped(target, doing, err)
  }
}

/** `runEvictingOnEngineTrap` for work that answers later, such as a named read of the record. */
export async function runEvictingOnEngineTrapLater<T>(
  target: CachedTarget,
  doing: Exclude<DocumentEngineTrapError['doing'], 'running'>,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work()
  } catch (err) {
    return dropTrapped(target, doing, err)
  }
}

function dropTrapped(
  target: CachedTarget,
  doing: Exclude<DocumentEngineTrapError['doing'], 'running'>,
  err: unknown,
): never {
  if (!isEngineTrap(err)) throw err
  target.evict()
  log.error('the CRDT engine trapped on a cached document; the cached copy was dropped', {
    ...target.fields,
    doing,
    err: messageOf(err),
  })
  throw new DocumentEngineTrapError(target.subject, doing, err)
}

/** Chunks snapshot bytes and hands them to the store under the frontier they were exported at. */
export async function storeSnapshot(
  deps: ServerDeps,
  at: { readonly workspaceId: string; readonly documentId: DocumentId },
  snapshot: Uint8Array,
  frontier: Uint8Array,
  /** The frontier the document was loaded at, when it was loaded before this save. */
  basedOn?: Uint8Array,
): Promise<void> {
  const { manifest, chunks } = chunkSnapshot(snapshot, DEFAULT_SNAPSHOT_MAX_CHUNK_BYTES)
  await deps.documentStore.saveSnapshot({
    docRef: { kind: 'document', ...at },
    manifest,
    chunks,
    frontier: frontier as Uint8Array<ArrayBuffer>,
    ...(basedOn === undefined ? {} : { basedOn: basedOn as Uint8Array<ArrayBuffer> }),
  })
}

/**
 * Tells the composition root a save landed. After the bytes are safe, and
 * never allowed to undo them: what the composition root does here (the daemon
 * schedules a debounced compaction and a history checkpoint) is not part of
 * this write's correctness, so a scheduler that throws must not turn a
 * successful save into a failed one. It is logged rather than rethrown, so a
 * scheduler that keeps failing stops compacting on the record instead of in
 * silence.
 */
export async function announceDocumentWritten(
  deps: ServerDeps,
  workspaceId: string,
  documentId: DocumentId,
): Promise<void> {
  try {
    // A lookup that fails costs the observer its path, not the notification:
    // compaction is addressed by workspace and needs none.
    const path = await placementOf(deps, workspaceId, documentId)
    await deps.documentWritten({
      workspaceId,
      documentId,
      ...(path === undefined ? {} : { path }),
    })
  } catch (err) {
    log.warning('the document-written observer failed after a successful save', {
      workspaceId,
      documentId,
      err: messageOf(err),
    })
  }
}

async function placementOf(
  deps: ServerDeps,
  workspaceId: string,
  documentId: DocumentId,
): Promise<string | undefined> {
  try {
    return (await deps.documentIndex.resolveDocumentById({ workspaceId, documentId }))?.path
  } catch {
    return undefined
  }
}
