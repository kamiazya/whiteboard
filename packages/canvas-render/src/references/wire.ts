import type { AliasResolver } from '@kamiazya/whiteboard-codec'
import { documentIdSchema, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { LoadedReference, ReferenceGraph } from './loaded-reference.js'
import type { ResolvedReference } from './resolved.js'
import { type ReferenceSeams, referenceSeams } from './seams.js'
import { imageTargets, type ReferenceSeeds, referenceTargets, writtenTargets } from './targets.js'

/**
 * What a surface adds beside a reference's loaded content — a label, an
 * image href, a facet card, a dangling mark — as data, so it can travel.
 * A test may hand content this way too; a keeper puts content in the
 * record, where the seams derive it once.
 */
export type ReferenceExtra = Partial<ResolvedReference> & {
  /**
   * The caller is still loading this reference (`isLoading`): an embed of it
   * draws the placeholder that says so. A wire cannot carry a function, so
   * "loading" travels as this mark.
   */
  readonly pending?: true
}

/**
 * The reference bundle as DATA, so it can cross a `postMessage`.
 *
 * A seam is a function and a function cannot be posted, which would leave the
 * layout worker drawing every text-node embed as a placeholder while the main
 * thread beside it could draw the note. The bundle is a pure
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
  /**
   * The targets the caller is still loading: each is asked of the alias and
   * title tables as a loaded one is, so an embed written by path still finds
   * its id, and its extra is marked `pending`.
   */
  readonly pending?: ReadonlySet<string>
  /**
   * The document the wire is drawn for. Its links, and those of every
   * record loaded, are asked of the alias table too — past the loading
   * budget as well, since a link resolved by the caller's table needs no
   * load — so a link the walk never reached still resolves.
   */
  readonly seeds?: ReferenceSeeds
}

const isDocumentId = (target: string): boolean => documentIdSchema.safeParse(target).success

/**
 * Every target the caller's tables are asked of: what loaded, what is still
 * loading, and — when there is a table to ask — every link the seeds and
 * what loaded write, past the loading budget too.
 */
function askedOf(
  graph: ReferenceGraph,
  pending: ReadonlySet<string>,
  options: ReferenceWireOptions,
): ReadonlySet<string> {
  const asks = options.resolveAlias !== undefined || options.resolveTitle !== undefined
  const written = asks ? writtenTargets({ ...options.seeds, loaded: graph }) : []
  return new Set([...graph.keys(), ...pending, ...written])
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
  const pending = options.pending ?? new Set<string>()
  const asked = askedOf(graph, pending, options)
  // A canonical id names itself, so its link is titled without an alias.
  const ids = new Set([...asked].filter(isDocumentId))
  for (const key of asked) {
    const entry = graph.get(key) ?? null
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
  const extras = new Map(options.extras ?? new Map<string, ReferenceExtra>())
  for (const target of pending) extras.set(target, { ...extras.get(target), pending: true })
  return { entries: [...graph.entries()], aliases, titles, extras: [...extras] }
}

/**
 * A wire with a surface's chrome layered over what it resolves: a readable
 * label for a reference a keeper knows only by id, and the references it
 * holds as dangling. Both become extras, merged over the one a reference
 * already carries, so the label wins over a record's name exactly as it
 * would over any other — and so they reach a worker and the Rust core as the
 * same bytes as the rest of the wire, where a composed function could reach
 * neither. Hands the wire back unchanged when there is nothing to layer.
 */
export function overlayReferences(
  wire: ReferenceWire,
  chrome: {
    readonly labels?: ReadonlyMap<string, string>
    readonly missing?: ReadonlySet<string>
  },
): ReferenceWire {
  const labels = chrome.labels ?? new Map<string, string>()
  const missing = chrome.missing ?? new Set<string>()
  if (labels.size === 0 && missing.size === 0) return wire
  const extras = new Map(wire.extras)
  for (const ref of new Set([...labels.keys(), ...missing])) {
    const label = labels.get(ref)
    extras.set(ref, {
      ...extras.get(ref),
      ...(label !== undefined ? { label } : {}),
      ...(missing.has(ref) ? { missing: true } : {}),
    })
  }
  return { ...wire, extras: [...extras] }
}

const WIRES = new WeakMap<ReferenceSeams, ReferenceWire>()

/** The bundle again, from the wire — the same on both sides of it. */
export function referenceSeamsFromWire(wire: ReferenceWire): ReferenceSeams {
  const aliases = new Map(wire.aliases)
  const titles = new Map(wire.titles)
  const pending = new Set<string>()
  const extras = new Map<string, ReferenceExtra>()
  for (const [ref, { pending: loading, ...extra }] of wire.extras) {
    if (loading === true) pending.add(ref)
    // The last of a key wins, an empty extra included; a mark that only says
    // a target is loading carries no extra of its own.
    if (loading !== true || Object.keys(extra).length > 0) extras.set(ref, extra)
  }
  const seams = referenceSeams(new Map(wire.entries), {
    resolveAlias: (alias) => aliases.get(alias) ?? null,
    resolveTitle: (documentId) => titles.get(documentId),
    extra: (ref) => extras.get(ref),
    pending,
  })
  WIRES.set(seams, wire)
  return seams
}

/**
 * The wire a bundle was rebuilt from, when it was: the one form of the
 * seams the Rust core can be handed, since it answers them from the same
 * tables rather than through functions (ADR-0054 step 7).
 */
export function wireOfSeams(seams: ReferenceSeams): ReferenceWire | undefined {
  return WIRES.get(seams)
}

/**
 * The rows of a wire that laying out these seeds can read: what they name,
 * transitively through what loaded (`referenceTargets`), the pictures they
 * draw (`imageTargets`), and the ids those rows resolve to.
 *
 * A keeper's wire can hold more than one canvas reads — the editor grows it
 * for a body being DRAFTED beside the canvas, so the overlay's preview
 * resolves a link before the commit. Those rows never reach the canvas's
 * layout, so the layout must not re-run or drop its content cache when they
 * arrive; restricting the wire first is what makes "the same bytes" the
 * test for that. Row order is the wire's, so the restriction is idempotent
 * byte for byte.
 */
export function referenceWireFor(
  wire: ReferenceWire,
  seeds: { readonly canvases?: readonly SpatialCanvas[]; readonly bodies?: readonly string[] },
): ReferenceWire {
  const loaded = new Map(wire.entries)
  const keys = new Set(referenceTargets({ ...seeds, loaded }))
  // `referenceTargets` names documents; a picture is not one, and its href
  // still rides the wire as an extra the layout draws.
  for (const ref of imageTargets({ ...seeds, loaded })) keys.add(ref)
  // An alias costs no load, so the links past the loading budget keep theirs.
  const read = new Map([...loaded].filter(([key]) => keys.has(key)))
  const written = new Set(writtenTargets({ ...seeds, loaded: read }))
  const aliases = wire.aliases.filter(([key]) => keys.has(key) || written.has(key))
  const ids = new Set(aliases.map(([, id]) => id))
  for (const target of written) if (isDocumentId(target)) ids.add(target)
  for (const [key, entry] of wire.entries) {
    if (keys.has(key) && entry !== null) ids.add(entry.documentId ?? key)
  }
  return {
    entries: wire.entries.filter(([key]) => keys.has(key)),
    aliases,
    titles: wire.titles.filter(([id]) => ids.has(id)),
    extras: wire.extras.filter(([key]) => keys.has(key)),
  }
}
