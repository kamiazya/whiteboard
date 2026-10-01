/**
 * The document-container seam, and every container key: the modules that
 * read and write a document's planes (`loro-bridge.ts`, `document-envelope.ts`,
 * `markdown-body.ts`, `comment-threads.ts`, `proposals.ts`) all reach for a
 * key here and never for each other, which is what keeps them from forming a
 * value cycle `cycle-check.ts` would fail on.
 */
import type { LoroMap, LoroText } from 'loro-crdt'

/**
 * Where one document's containers live.
 *
 * Every function in this package reaches for containers by name and never for the
 * document as a whole, so the only thing it needs is something that can hand
 * one over. `LoroDoc` satisfies this structurally — a document's containers
 * are its roots — and so does a workspace-tree node, whose containers hang off
 * its own meta map. That is the whole reason this type exists: the two storage
 * models differ in WHERE a container is found and in nothing else, so the
 * bridge should not have to be written twice.
 *
 * Call sites that pass a `LoroDoc` keep compiling unchanged.
 */
export interface DocumentContainers {
  getMap(key: string): LoroMap
  getText(key: string): LoroText
  /**
   * Part of the seam because the bridge decides where a write ENDS, and that
   * is not something to leave each caller to remember. A tree-node host
   * delegates to the document its node belongs to.
   */
  commit(): void
}

/**
 * The comment plane as it was BEFORE threads (ADR-0024): one flat entry per
 * comment. Nothing writes here any more — `migrateCanvasCommentsToThreads`
 * empties it and `readSpatialCanvas` reads it only as a fallback for a
 * document no writer has touched since. Retire the key once nothing needs
 * that fallback.
 */
export const COMMENTS_KEY = 'comments'
/**
 * The annotation layer's thread plane (ADR-0026), one level deeper than the
 * comments map above: a map of thread containers, each holding its anchor and
 * status beside a nested map of MESSAGES keyed by message id. The extra level
 * is the whole point — a thread stored as one value would lose one of two
 * concurrent replies to last-writer-wins, silently.
 *
 * Read and written by `comment-threads.ts`, and named in
 * `CONTENT_CONTAINER_KEYS` so a tree-node host pre-attaches it.
 */
export const THREADS_KEY = 'threads'

/**
 * The proposal layer's plane (ADR-0029), shaped like `threads` above and for
 * the same reason: a map of proposal containers, each holding its provenance
 * beside a nested map of CHANGES keyed by change id. The nesting is what lets
 * two people decide different parts of one proposal at once without either
 * verdict overwriting the other.
 *
 * Read and written by `proposals.ts`, and named in `CONTENT_CONTAINER_KEYS`
 * so a tree-node host pre-attaches it — which also means a pending proposal
 * moves the document's content digest, and a listing shows the document as
 * having changed. That is the intended reading: something happened to this
 * document that somebody should look at.
 */
export const PROPOSALS_KEY = 'proposals'

// ── The spatial canvas's planes ──────────────────────────────────────────────

export const NODES_KEY = 'nodes'
export const EDGES_KEY = 'edges'
// Ink (ADR-0038 decision 2), in its own plane for the reason edges have one:
// per-element keys, so two peers drawing concurrently both survive.
export const LINES_KEY = 'lines'

/**
 * The canvas ENVELOPE — properties of the canvas rather than of anything on
 * it (today: the `x-whiteboard` rendering preferences).
 *
 * A third top-level map rather than a field beside the node entries, because
 * the merge story is different in kind. Nodes and edges are keyed per object
 * so two peers editing different objects both survive; a canvas-wide
 * preference is ONE value with one meaning, and last-writer-wins per key is
 * the whole of what it needs.
 */
export const CANVAS_KEY = 'canvas'
export const FACETS_KEY = 'facets'
// Editor state that is NOT canvas content: stored beside the canvas in the
// same doc (so it survives reload and syncs to peers) but in its own map,
// which is what keeps it out of every export — `readSpatialCanvas` reads
// only NODES_KEY/EDGES_KEY, and every export path goes through it.
export const NODE_LOCKS_KEY = 'nodeLocks'
export const EDGE_LOCKS_KEY = 'edgeLocks'

export const CORE_KEY = 'core'
/**
 * OKF v0.2's trust family gets a bucket of its own rather than joining
 * `core`, because `writeCoreFacets` replaces the whole core bucket and
 * deletes anything the caller omitted — a server-written stamp living there
 * would be erased by any client that rewrote its own tags (ADR-0016).
 */
export const TRUST_KEY = 'trust'

/**
 * Document-level envelope: what the document IS, above any one format's
 * structure. Kept out of `core` because that map is OKF frontmatter, which
 * a JSON Canvas document has no business carrying (ADR-0009 decision 3).
 */
export const DOCUMENT_KEY = 'document'

/** A bucket's entries as a plain object: what a `LoroMap` is written from and read into. */
export type Fields = Record<string, unknown>

/**
 * The Loro text container a markdown document's body lives in, and the one
 * apps/web's browser-local editor binds its CRDT editing session to.
 *
 * Exported because that binding needs the container HANDLE, not its text —
 * `readMarkdownBody` cannot serve it, and a second `'body'` literal on the
 * apps/web side would be a contract duplicated across a package boundary.
 */
export const MARKDOWN_BODY_KEY = 'body'
