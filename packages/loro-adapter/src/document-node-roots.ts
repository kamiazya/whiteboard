// Which roots of a standalone document a workspace node cannot take as
// content. The tree write skips them (`rootFitsNode`); a keeper refusing a
// client's update asks here, so the client is told rather than left believing
// a write that never lands.
import type { LoroDoc } from 'loro-crdt'
import { PROJECTED_KIND_OF } from './content-sync.js'
import { CONTENT_CONTAINER_KEYS } from './loro-bridge.js'
import { NODE_META_KEYS } from './workspace-tree.js'

const CONTENT_KIND_OF: ReadonlyMap<string, 'map' | 'text'> = new Map(
  CONTENT_CONTAINER_KEYS.map(({ key, kind }) => [key, kind]),
)

/**
 * The roots of `source` named after a key a document node keeps for itself,
 * or after a content container but of another kind. Reads the root list
 * alone, never the roots' contents, so it costs the same however large the
 * document is.
 */
export function rootsNoDocumentNodeHolds(source: LoroDoc): string[] {
  const refused: string[] = []
  for (const [key, id] of Object.entries(source.getShallowValue())) {
    const kind = PROJECTED_KIND_OF[String(id).slice(String(id).lastIndexOf(':') + 1)]
    const content = CONTENT_KIND_OF.get(key)
    if (NODE_META_KEYS.has(key) || (content !== undefined && content !== kind)) refused.push(key)
  }
  return refused
}
