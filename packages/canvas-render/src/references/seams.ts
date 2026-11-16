import {
  type AliasResolver,
  parseMarkdownBody,
  resolveReferences,
} from '@kamiazya/whiteboard-codec'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import type { LoadedReference, ReferenceGraph } from './loaded-reference.js'
import type { EmbeddedDocument, ResolvedReference } from './resolved.js'

/**
 * Every synchronous seam a layout reads to draw what a document points at,
 * built together from one graph so no surface can wire three of the four.
 *
 * `resolveAlias` is codec's (a `[[target]]` to a document id), the other
 * three are the layout's: what labels a bare link, what a `![[embed]]`
 * draws, what a file node draws. Produced by hand in every composition root
 * they diverge — one root answering canvases and not bodies, another bodies
 * and not canvases — and the layout, total by design, draws placeholders for
 * whichever is missing rather than failing. This is the
 * one producer; a root supplies the graph and gets all four.
 */
export interface ReferenceSeams {
  readonly resolveAlias: AliasResolver
  readonly resolveTitle: (documentId: string) => string | undefined
  readonly resolveEmbed: (documentId: string) => EmbeddedDocument | undefined
  /** A target asked for and not yet answered; absent when the keeper has nothing in flight. */
  readonly isLoading?: (documentId: string) => boolean
  readonly resolveReference: (ref: string) => ResolvedReference | undefined
}

export interface ReferenceSeamsOptions {
  /**
   * A keeper's own alias table — a page's document list — consulted before
   * the graph. It answers instantly for a target nothing has loaded yet,
   * which is what lets a prefetch know WHAT to load, and it is how a
   * `[[path]]` reads as a link before its target arrives.
   */
  readonly resolveAlias?: AliasResolver
  /** Same for names: the list a page already holds, ahead of any load. */
  readonly resolveTitle?: (documentId: string) => string | undefined
  /**
   * Targets, as written, that a keeper has asked for and not yet answered.
   * Distinct from a `null` graph entry ("looked up, nothing there"): the
   * layout draws a loading frame for the first and the unresolvable
   * placeholder for the second.
   */
  readonly pending?: ReadonlySet<string>
  /**
   * What a surface knows about a file reference beyond its document — an
   * image asset's URL, a facet card. Merged over the shared fields, and the
   * only place a surface adds to a reference rather than replacing how one
   * is read.
   */
  readonly extra?: (
    ref: string,
    loaded: LoadedReference | null | undefined,
  ) => Partial<ResolvedReference> | undefined
}

/**
 * The seams over a graph. Pure and synchronous: a body is parsed once per
 * record, with the alias resolver these seams themselves answer, so a
 * reference inside an embedded body resolves the same way as one in the
 * document that embeds it.
 *
 * One rule decides what a record IS, for every seam alike: a record with a
 * body is a markdown document, whatever else it carries (the pre-container
 * storage shape reads back as a one-node canvas too, and drawing that as a
 * canvas would show the prose crushed to thumbnail size). Only a record with
 * no body offers its canvas, and a file node draws an EMPTY canvas as the
 * card rather than as an empty frame, where an embed keeps the frame so the
 * name it links stays visible.
 */
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

  const parsed = new Map<LoadedReference, MdastRoot | undefined>()
  const rootOf = (entry: LoadedReference): MdastRoot | undefined => {
    if (parsed.has(entry)) return parsed.get(entry)
    let root: MdastRoot | undefined
    try {
      root =
        entry.body === undefined
          ? undefined
          : resolveReferences(parseMarkdownBody(entry.body), resolveAlias)
    } catch {
      // Totality: a body the schema rejects costs that one reference its
      // prose, never the render.
      root = undefined
    }
    parsed.set(entry, root)
    return root
  }

  const resolveTitle = (documentId: string): string | undefined =>
    byId.get(documentId)?.name ?? options.resolveTitle?.(documentId)

  const resolveEmbed = (documentId: string): EmbeddedDocument | undefined => {
    const entry = byId.get(documentId)
    if (entry === undefined) return undefined
    // The record's own name first; the caller's table (a page's list, the
    // wire's title table) labels a keeper that loads content without names.
    const name = entry.name ?? options.resolveTitle?.(documentId)
    const title = name !== undefined ? { title: name } : {}
    if (entry.body !== undefined) {
      const root = rootOf(entry)
      return root === undefined ? undefined : { ...title, root }
    }
    return entry.canvas === undefined ? undefined : { ...title, canvas: entry.canvas }
  }

  const fileContent = (entry: LoadedReference): Partial<ResolvedReference> => {
    if (entry.body !== undefined) {
      const root = entry.body.trim().length > 0 ? rootOf(entry) : undefined
      return root === undefined ? {} : { markdown: root }
    }
    return entry.canvas !== undefined && entry.canvas.nodes.length > 0
      ? { canvas: entry.canvas }
      : {}
  }

  const resolveReference = (ref: string): ResolvedReference | undefined => {
    const entry = graph.get(ref)
    const extra = options.extra?.(ref, entry) ?? {}
    const shared: ResolvedReference =
      entry === undefined || entry === null
        ? {}
        : { ...(entry.name !== undefined ? { label: entry.name } : {}), ...fileContent(entry) }
    const resolved = { ...shared, ...extra }
    return Object.keys(resolved).length === 0 ? undefined : resolved
  }

  return withLoading(
    { resolveAlias, resolveTitle, resolveEmbed, resolveReference },
    options.pending,
  )
}

/**
 * The seams plus a loading check. An embed names a resolved document id while
 * a keeper asks by the target as written, so a pending path counts for the id
 * it resolves to as well. No check is attached when nothing is in flight,
 * which keeps the seams exactly as they were for a host that loads nothing
 * asynchronously.
 */
function withLoading(
  seams: ReferenceSeams,
  pending: ReadonlySet<string> | undefined,
): ReferenceSeams {
  if (pending === undefined || pending.size === 0) return seams
  const isLoading = (documentId: string): boolean => {
    if (pending.has(documentId)) return true
    for (const target of pending) if (seams.resolveAlias(target) === documentId) return true
    return false
  }
  return { ...seams, isLoading }
}
