import {
  type AliasResolver,
  parseMarkdownBody,
  resolveReferences,
} from '@kamiazya/whiteboard-codec'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import type { EmbeddedDocument, MdastLayoutOptions } from '../layout/nodes/mdast-blocks.js'
import type { ResolvedReference } from '../layout/spatial-canvas.js'
import type { LoadedReference, ReferenceGraph } from './loaded-reference.js'

/**
 * Every synchronous seam a layout reads to draw what a document points at,
 * built together from one graph so no surface can wire three of the four.
 *
 * `resolveAlias` is codec's (a `[[target]]` to a document id), the other
 * three are the layout's: what labels a bare link, what a `![[embed]]`
 * draws, what a file node draws. They used to be produced by hand in every
 * composition root — one root answered canvases and not bodies, another
 * bodies and not canvases — and the layout, total by design, drew
 * placeholders for whichever was missing rather than failing. This is the
 * one producer; a root supplies the graph and gets all four.
 */
export interface ReferenceSeams {
  readonly resolveAlias: AliasResolver
  readonly resolveTitle: NonNullable<MdastLayoutOptions['resolveTitle']>
  readonly resolveEmbed: NonNullable<MdastLayoutOptions['resolveEmbed']>
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
    const title = entry.name !== undefined ? { title: entry.name } : {}
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

  return { resolveAlias, resolveTitle, resolveEmbed, resolveReference }
}

/**
 * The file-reference seam with plain-data chrome layered over what the
 * graph resolved: readable labels for references a keeper knows only by
 * name, and the dangling ones. ONE producer for every thread — a layout
 * worker rebuilds it from the two lists that crossed as data, the main
 * thread builds it from the seams it has — because two hand-written
 * compositions of "label overrides content" is how the offloaded and the
 * synchronous render of one canvas start disagreeing about what it says.
 *
 * `undefined` when nothing is supplied, so a host that wires none leaves
 * the layout exactly as it was.
 */
export function overlayReferences(parts: {
  readonly content?: (ref: string) => ResolvedReference | undefined
  readonly labels?: ReadonlyMap<string, string>
  readonly missing?: ReadonlySet<string>
}): ((ref: string) => ResolvedReference | undefined) | undefined {
  const { content, labels, missing } = parts
  const hasLabels = labels !== undefined && labels.size > 0
  const hasMissing = missing !== undefined && missing.size > 0
  if (content === undefined && !hasLabels && !hasMissing) return undefined
  return (ref) => {
    const resolved = content?.(ref)
    const label = hasLabels ? labels.get(ref) : undefined
    const isMissing = hasMissing && missing.has(ref)
    if (resolved === undefined && label === undefined && !isMissing) return undefined
    return {
      ...resolved,
      ...(label !== undefined ? { label } : {}),
      ...(isMissing ? { missing: true } : {}),
    }
  }
}

/**
 * Layout options with the bundle's markdown seams applied — an individual
 * seam a caller set wins, so a test can still probe one in isolation. The
 * entry points call this once, which is what makes `references` the only
 * thing a composition root has to pass.
 */
export function withReferenceSeams<
  T extends {
    readonly references?: ReferenceSeams
    readonly resolveEmbed?: MdastLayoutOptions['resolveEmbed']
    readonly resolveTitle?: MdastLayoutOptions['resolveTitle']
  },
>(options: T): T {
  const seams = options.references
  if (seams === undefined) return options
  return {
    ...options,
    resolveEmbed: options.resolveEmbed ?? seams.resolveEmbed,
    resolveTitle: options.resolveTitle ?? seams.resolveTitle,
  }
}
