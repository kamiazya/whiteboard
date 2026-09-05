import type { AliasResolver } from '@kamiazya/whiteboard-codec'
import type { ResolvedReference } from '../layout/spatial-canvas.js'
import type { LoadedReference, ReferenceGraph } from './loaded-reference.js'
import { type ReferenceSeams, referenceSeams } from './seams.js'

/**
 * What a surface adds beside a reference's loaded content — a label, an
 * image href, a facet card, a dangling mark — as data, so it can travel.
 * A test may hand content this way too; a keeper puts content in the
 * record, where the seams derive it once.
 */
export type ReferenceExtra = Partial<ResolvedReference>

/**
 * The reference bundle as DATA, so it can cross a `postMessage`.
 *
 * A seam is a function and a function cannot be posted, which is why the
 * layout worker used to draw every text-node embed as a placeholder while
 * the main thread beside it could have drawn the note. The bundle is a pure
 * function of what was loaded plus three finite tables, so the tables are
 * what cross: the alias each written target resolved to, the title of each
 * id the graph can name, and the extras a surface attached per reference.
 * `referenceSeamsFromWire` rebuilds the bundle on either side of the wire
 * from the same bytes, which is what makes the two renders agree by
 * construction rather than by a parity test alone.
 */
export interface ReferenceWire {
  readonly entries: readonly (readonly [string, LoadedReference | null])[]
  /** Written target -> the id the caller's table resolved it to. */
  readonly aliases: readonly (readonly [string, string])[]
  /** Document id -> display name, for every id the graph or the aliases name. */
  readonly titles: readonly (readonly [string, string])[]
  readonly extras: readonly (readonly [string, ReferenceExtra])[]
}

export interface ReferenceWireOptions {
  readonly resolveAlias?: AliasResolver
  readonly resolveTitle?: (documentId: string) => string | undefined
  readonly extras?: ReadonlyMap<string, ReferenceExtra>
}

/**
 * Evaluates the caller's tables over what the graph names — every written
 * target and every id a record or an alias answers with — so nothing a body
 * in this graph can ask is left for a function that cannot travel.
 */
export function referenceWire(
  graph: ReferenceGraph,
  options: ReferenceWireOptions = {},
): ReferenceWire {
  const aliases: [string, string][] = []
  const ids = new Set<string>()
  for (const [key, entry] of graph) {
    if (entry !== null) ids.add(entry.documentId ?? key)
    const own = options.resolveAlias?.(key)
    if (own !== undefined && own !== null) {
      aliases.push([key, own])
      ids.add(own)
    }
  }
  const titles: [string, string][] = []
  for (const id of ids) {
    const title = options.resolveTitle?.(id)
    if (title !== undefined) titles.push([id, title])
  }
  return {
    entries: [...graph.entries()],
    aliases,
    titles,
    extras: [...(options.extras ?? new Map<string, ReferenceExtra>()).entries()],
  }
}

/** The bundle again, from the wire — the same on both sides of it. */
export function referenceSeamsFromWire(wire: ReferenceWire): ReferenceSeams {
  const aliases = new Map(wire.aliases)
  const titles = new Map(wire.titles)
  const extras = new Map(wire.extras)
  return referenceSeams(new Map(wire.entries), {
    resolveAlias: (alias) => aliases.get(alias) ?? null,
    resolveTitle: (documentId) => titles.get(documentId),
    extra: (ref) => extras.get(ref),
  })
}
