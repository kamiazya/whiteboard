import type { BlobStore, DocumentIndex, DocumentStore } from '@kamiazya/whiteboard-ports'

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
   * Optional on purpose: every existing composition — and every test — is a
   * valid server without one, and a tool that needed a browser to be present
   * would stop being headless. Absent means nobody is told anything.
   */
  clientNotifier?: CanvasClientNotifier
}
