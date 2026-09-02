/**
 * The document-container seam, and the container keys more than one module
 * reads. A key lives here once a second module needs it and stays in
 * `loro-bridge.ts` until then — which is also what keeps the two comment
 * modules from importing each other.
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
