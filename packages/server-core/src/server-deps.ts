import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { DocumentId, DocumentKind } from '@kamiazya/whiteboard-model'
import type { BlobStore, DocumentIndex, DocumentStore } from '@kamiazya/whiteboard-ports'
import type { LoroDoc } from 'loro-crdt'
import type { Embedder } from './search/embedder.js'

/**
 * What a batch of agent edits touched, as the browser needs to hear it.
 *
 * Deliberately carries no operator identity: server-core does not know who
 * the daemon's peer is, and inventing a peerId here would put a second
 * source of truth beside the one `ws-messages.ts` already has. The
 * implementation fills it in.
 */
export interface AgentActivity {
  readonly workspaceId: string
  readonly documentId: string
  readonly touched: { readonly nodes: readonly string[]; readonly edges: readonly string[] }
  /** One short human-readable line, e.g. "added 5 nodes". */
  readonly summary: string
}

/**
 * The subset of an op `summarizeOps` reads. Declared here rather than
 * imported from the tool so the port file does not depend on the tool that
 * uses it.
 */
export type CanvasOpSummaryInput = { readonly op: string; readonly locked?: boolean }

export interface ViewportRequest {
  readonly workspaceId: string
  readonly documentId: string
  readonly mode?: 'fit' | 'move'
  readonly elementIds?: readonly string[]
  readonly animate?: boolean
  readonly scrollX?: number
  readonly scrollY?: number
  readonly zoom?: number
}

/**
 * The seam through which a tool reaches a browser watching the same
 * document. Everything here is BEST EFFORT and one-way: a headless daemon
 * with no tab open is the normal case, not an error, so nothing a tool does
 * may fail because nobody was listening.
 *
 * `requestViewport` answers whether there was a ready client to send to —
 * enough for a tool to tell an agent "nobody is watching" without turning
 * that into a failure.
 *
 * ponytail: fire-and-forget, no browser ACK. The HTTP viewport route awaits
 * one because an HTTP caller asked a question; an agent cannot act on the
 * difference between "sent" and "applied", so this does not pay for the
 * round trip.
 */
export interface CanvasClientNotifier {
  agentActivity(activity: AgentActivity): void
  requestViewport(request: ViewportRequest): Promise<boolean>
}

export interface ServerDeps {
  documentStore: DocumentStore
  blobStore: BlobStore
  /**
   * Where a document's placement lives. Separate from `documentStore`, which
   * owns one document's bytes and knows nothing about where it sits — and the
   * reason an agent-created document is one the user's canvas list can show:
   * both surfaces now write the same index.
   */
  documentIndex: DocumentIndex
  /**
   * The trash a delete evacuated into: listable, and restorable under the
   * SAME documentId. OPTIONAL because it is a capability of the tree-backed
   * index the daemon composition binds, not part of the `DocumentIndex`
   * port — a deps literal without it simply has no trash surface, and the
   * routes answer 501 rather than pretending.
   */
  trash?: {
    list(input: {
      workspaceId: string
    }): Promise<{ documentId: string; path: string; deletedAt: number }[]>
    restore(input: {
      workspaceId: string
      documentId: string
    }): Promise<{ documentId: string; path: string } | null>
  }
  /**
   * How to measure text when laying a scene out. Optional because
   * server-core is a shared layer forbidden from loading a font itself
   * (architecture-map.md) — absent, the render/digest tools degrade to
   * canvas-render's `constantRatioMeasureText`, which matches no real
   * font.
   *
   * Asynchronous, and a factory rather than a value, because the real
   * implementation parses a font file: the composition root's own measurer
   * memoizes that parse, so calling this per request costs one resolved
   * promise and startup pays nothing for a server that never renders.
   */
  measure?: () => Promise<MeasureText>
  /**
   * Turns document search from lexical-only into lexical fused with
   * semantic. Optional for the same reason `measure` is: server-core is a
   * shared layer and cannot load a model itself, and absent means search
   * behaves exactly as it did before embeddings existed — the pinned
   * scoreboard passes unchanged either way.
   */
  embedder?: Embedder
  /**
   * Optional on purpose: every existing composition — and every test — is a
   * valid server without one, and a tool that needed a browser to be present
   * would stop being headless. Absent means nobody is told anything.
   */
  clientNotifier?: CanvasClientNotifier
  /**
   * The facet registry validating registered-facet writes (ADR-0013
   * decision 6). Optional: absent means the bundled plugins — a composition
   * root overrides it only when a deployment configures its own plugin set.
   */
  facetRegistry?: FacetRegistry
  /**
   * How a composition root disposes of everything about a document that is
   * NOT its index row or its stored bytes — thumbnail and blob files on
   * disk, a cached doc instance, anything else it alone knows about.
   *
   * It exists because those two are all server-core can name, and deleting
   * only them left an agent-deleted document half-deleted: stale files and
   * a stale cache entry that a document deleted through the composition
   * root's own path would not have left behind. Two teardown paths that
   * disagree is worse than one that is incomplete.
   *
   * REQUIRED, unlike `measure` and `clientNotifier`, and that is the whole
   * defence: a composition root that forgets it is a compile error rather
   * than a server that silently half-deletes. Optional is what let the
   * original defect exist, and a hand-written "is it wired?" assertion only
   * ever covers the dependencies somebody remembered to write one for.
   *
   * A test whose subject is elsewhere passes `unusedDocumentTeardown()`,
   * whose `around` throws — the same idiom as `unusedDocumentIndex`, and for
   * the same reason: a no-op double would let a delete test pass while
   * asserting nothing about the cleanup, which is the state this repo was
   * in before the seam existed.
   */
  documentTeardown: DocumentTeardown
  /**
   * Told which document a write just changed, so a composition root can do
   * whatever it keeps outside the store — the daemon schedules a debounced
   * auto-compaction of the op-log.
   *
   * The write side of the gap `documentTeardown` closed on the delete side.
   * The daemon's HTTP write path fired a saved-listener that scheduled
   * compaction; this path — every agent write — reached the store directly
   * and told nobody, so an agent-driven canvas never compacted.
   *
   * REQUIRED for the same reason as `documentTeardown`: optional is one
   * keystroke from unwired, and unwired here is invisible until a canvas
   * has grown unbounded.
   *
   * Awaited but never allowed to fail the write. The bytes are already
   * safe by the time this runs, and a background compaction that could not
   * be SCHEDULED is not a reason to report a failed save — so the caller
   * swallows what this throws, and `document-io.test.ts` pins that rather
   * than leaving it to a comment.
   */
  documentWritten: DocumentWritten
  /**
   * A document's saved history, as an OPERATION needs to read it.
   *
   * Three methods, not the eleven the daemon's own version store has. A
   * seam states what the operation needs; the implementation is free to be
   * larger, and structural typing lets it satisfy this without a wrapper.
   * Thumbnails, pruning and branch rewriting are not read by any operation
   * here, and publishing them would make this a second name for a mechanic
   * rather than a seam.
   *
   * REQUIRED, for the reason `documentTeardown` is: a composition root that
   * forgets it should be a compile error, not a server whose restore
   * silently answers "no such version" for every version that exists.
   *
   * Not a `packages/ports` port, despite the shape. Ports may depend on
   * model and zod only, and these answer with a `LoroDoc` — so this belongs
   * beside the other seams, exactly as `documentTeardown` does.
   */
  versions: VersionHistory
  /**
   * The workspace's LIVE documents — the cached, mutable doc instances every
   * connected client shares — as an operation needs to touch them.
   *
   * Narrow-seam rules as `versions`: these are the calls the restore
   * operation makes, not the daemon store's whole surface, and structural
   * typing lets the implementation be larger without a wrapper. Not a
   * `packages/ports` port for the same reason `versions` is not — the
   * methods answer with a `LoroDoc`.
   *
   * REQUIRED, like `documentTeardown`: a composition root that forgets it
   * should be a compile error, not a server whose restore route throws at
   * request time. Tests whose subject is elsewhere pass
   * `unusedLiveDocuments()`, which refuses.
   */
  liveDocuments: LiveDocuments
  /**
   * The workspace-granularity half of the live-document surface: ONE Loro
   * doc per workspace holding the tree and every document's content plane.
   * The axis the restore increment named and deferred; ws.ts's migration
   * (the last scheduled adapter) reuses it.
   *
   * Deliberately has NO lock method: the workspace write lock is
   * `liveDocuments.withWriteLock`, and it is the SAME lock — a second
   * spelling would let two surfaces each hold "the" lock and interleave.
   *
   * REQUIRED, like `liveDocuments`, and for the same reason.
   */
  workspaceDocuments: WorkspaceDocuments
}

export interface WorkspaceDocuments {
  /** Whether the workspace is registered at all — a refusal, not a mint. */
  exists(workspaceId: string): Promise<boolean>
  /**
   * The live workspace doc. Inside a registered workspace a missing record
   * is minted empty: the workspace is real, it just has no tree-plane
   * documents yet.
   */
  get(workspaceId: string): Promise<LoroDoc>
  /**
   * Persists the workspace doc. Fan-out to update subscribers happens
   * INSIDE the implementation, so a caller never broadcasts separately.
   */
  save(workspaceId: string, doc: LoroDoc): Promise<void>
  /**
   * Drops every cached per-document projection of this workspace. After a
   * workspace-granularity import each projection is stale, and a stale one
   * would diff old content back over the import on its next save.
   */
  evictProjections(workspaceId: string): void
  /**
   * Drops the cached workspace doc itself, so the next `get` reloads
   * durable bytes — the recovery move when a failure may have left the
   * in-memory doc ahead of what persisted.
   */
  evict(workspaceId: string): void
  /**
   * Subscribes to every persisted workspace-document update — the sync
   * fan-out funnel. Listeners get the exact bytes the store persisted;
   * importing them into a replica converges it. Best-effort and
   * order-independent, the clientNotifier-shaped events carve-out: a
   * listener throwing must never fail the save that fired it (the
   * implementation guards this). Answers an unsubscribe.
   */
  onUpdated(listener: (workspaceId: string, update: Uint8Array) => void): () => void
}

/**
 * `withWriteLock` is ON the seam, not around it, because the operation is
 * what must hold it: every read and write of a restore runs inside one hold
 * (an unlocked get->save window lets a concurrent delete/rename insert a
 * phantom canvas), and a lock the adapter takes is a lock a second surface
 * forgets. The bracket must be re-entrant — `save`/`rename`/`delete`
 * implementations may take the same lock again.
 */
export interface LiveDocuments {
  /** The live (cached) doc at `path`; an unknown path answers an empty doc. */
  get(workspaceId: string, path: string): Promise<LoroDoc>
  /**
   * Persists `doc` at `path`. Without `overwrite`, a path already held —
   * checked again inside the store, not only by the caller's `exists` —
   * rejects with ports' `DocumentPathTakenError`, which is the one failure
   * an operation turns into a result rather than propagating.
   */
  save(
    workspaceId: string,
    path: string,
    doc: LoroDoc,
    options?: { overwrite?: boolean; kind?: DocumentKind },
  ): Promise<void>
  exists(workspaceId: string, path: string): Promise<boolean>
  /** The document's recorded kind, or null when the path holds none. */
  kind(workspaceId: string, path: string): Promise<DocumentKind | null>
  /** Every document in the workspace; `id` is absent for uncorrelatable rows. */
  list(workspaceId: string): Promise<readonly { id?: string; path: string }[]>
  rename(workspaceId: string, oldPath: string, newPath: string): Promise<void>
  delete(workspaceId: string, path: string): Promise<void>
  /**
   * Drops the cached doc instance so the next read reloads durable state —
   * the recovery move after a failed write left the cache ahead of disk.
   */
  evict(workspaceId: string, path: string): void
  withWriteLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T>
}

/**
 * `path` addresses the version LIST because a version belongs to a document
 * at the name it had; `load` and `loadWorkspaceAt` take only the version's
 * own id, which is already unique within the workspace.
 */
export interface VersionHistory {
  /**
   * The past state of ONE document, as an independent doc — the stored
   * record checked out at this version's frontiers. Null only when the
   * version does not exist.
   */
  load(workspaceId: string, id: string): Promise<LoroDoc | null>
  /**
   * The whole WORKSPACE at this version, which is what a subtree rollback
   * walks. Null when the version exists but is not workspace-scoped, which
   * is a real answer and not an error: a per-document version cannot say
   * where its siblings were.
   */
  loadWorkspaceAt(workspaceId: string, id: string): Promise<LoroDoc | null>
  /** Saved versions of the document at `path`, newest first. */
  list(workspaceId: string, path: string): Promise<readonly { id: string; label?: string }[]>
}

// Carries the workspaceId because the tree is the address book: resolving a
// bare documentId back to its workspace would mean scanning every workspace
// record, while every tool write already knows which workspace it wrote.
export type DocumentWritten = (input: {
  workspaceId: string
  documentId: DocumentId
}) => Promise<void>

/**
 * A BRACKET around the delete, not a pair of hooks, because two separate
 * things have to be true at once.
 *
 * The information the cleanup needs stops existing partway through: a
 * version's thumbnail is filed under the version id, and version rows
 * cascade away with the document, so what to unlink can only be read while
 * the document is still whole. And a composition root may need to hold
 * something across the WHOLE delete — the daemon holds its per-workspace
 * write lock — which a `begin` that has already returned cannot do.
 *
 * A begin/finalize pair gave the first without the second, and the gap was
 * real: a version saved between the capture and the row delete had its row
 * cascaded away while its thumbnail was never in the captured set, leaving
 * the orphaned file this seam exists to prevent.
 *
 * `deleteDocument` runs the delete itself. What it throws propagates, and
 * the cleanup is then skipped — the index refuses while documents sit below
 * this one, and a refused delete must destroy nothing.
 */
export interface DocumentTeardown {
  around<T>(
    input: {
      workspaceId: string
      documentId: string
      path: string
    },
    deleteDocument: () => Promise<T>,
  ): Promise<T>
}
