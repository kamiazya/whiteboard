import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import type { FacetRegistry } from '@kamiazya/whiteboard-facet-engine'
import type { DocumentId } from '@kamiazya/whiteboard-model'
import type { BlobStore, DocumentIndex, DocumentStore } from '@kamiazya/whiteboard-ports'
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
   * whose `begin` throws — the same idiom as `unusedDocumentIndex`, and for
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
}

export type DocumentWritten = (input: { documentId: DocumentId }) => Promise<void>

/**
 * Split in two because the information the cleanup needs stops existing
 * partway through the delete: a version's thumbnail is filed under the
 * version id, and version rows cascade away with the document. `begin` runs
 * while the document is still whole and returns what to run once it is gone.
 *
 * The finalizer runs only if the delete actually happened — the index
 * refuses while documents sit below this one, and a refused delete must
 * destroy nothing.
 */
export interface DocumentTeardown {
  begin(input: {
    workspaceId: string
    documentId: string
    path: string
  }): Promise<FinalizeDocumentTeardown>
}

export type FinalizeDocumentTeardown = () => Promise<void>
