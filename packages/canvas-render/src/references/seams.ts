import type { AliasResolver } from '@kamiazya/whiteboard-codec'
import type { LoadedReference, ReferenceGraph } from './loaded-reference.js'

/**
 * The synchronous lookups a keeper's alias and name tables answer, built from
 * one graph. What a layout draws of a reference is not read through these: the
 * core answers it from the wire the bundle was rebuilt from (`wireOfSeams`),
 * parsing the bodies itself.
 */
export interface ReferenceSeams {
  readonly resolveAlias: AliasResolver
  readonly resolveTitle: (documentId: string) => string | undefined
}

export interface ReferenceSeamsOptions {
  /**
   * A keeper's own alias table — a page's document list — consulted before
   * the graph, so a `[[path]]` resolves before its target arrives.
   */
  readonly resolveAlias?: AliasResolver
  /** Same for names: the list a page already holds, ahead of any load. */
  readonly resolveTitle?: (documentId: string) => string | undefined
}

/** The seams over a graph. Pure and synchronous. */
export function referenceSeams(
  graph: ReferenceGraph,
  options: ReferenceSeamsOptions = {},
): ReferenceSeams {
  const byId = new Map<string, LoadedReference>()
  for (const [key, entry] of graph) {
    if (entry !== null) byId.set(entry.documentId ?? key, entry)
  }

  const resolveAlias: AliasResolver = (alias) => {
    const own = options.resolveAlias?.(alias)
    if (own !== undefined && own !== null) return own
    return graph.get(alias)?.documentId ?? null
  }

  const resolveTitle = (documentId: string): string | undefined =>
    byId.get(documentId)?.name ?? options.resolveTitle?.(documentId)

  return { resolveAlias, resolveTitle }
}
