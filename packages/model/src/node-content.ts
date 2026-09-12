/**
 * What a node SHOWS, read without naming how it is stored.
 *
 * Today each answer is a field on one arm of the node-kind union. Under
 * [ADR-0038](../../../docs/contributing/adr/0038-ocif-projection.md) decision
 * 3 that union dissolves — text becomes a resource, a file a resource with a
 * location, a link a resource whose location is a URL — and these four
 * functions are where that change lands instead of at the ~121 call sites
 * that read `node.type` and `node.text` directly.
 *
 * `isFrame` is on the OTHER axis and is here to keep it distinguishable: a
 * group's dissolution (OCIF spells it `parent` plus `@ocif/group`) turns
 * membership from geometric into declared, which is a change to BEHAVIOUR
 * rather than to shape — `tidy-units.ts` says plainly that membership is
 * containment — so it is a separate decision from this one and wants its own
 * single reader when it is taken.
 */
import type { ResourceKind } from './node-resource.js'
import type { SpatialNode } from './spatial.js'

/**
 * What these accessors COST, recorded because the ADR does not weigh it.
 *
 * A `switch (node.type)` over the union is exhaustive: `searchable-texts.ts`
 * says so in as many words — "a fifth node kind has to answer this question
 * rather than fall through it" — and `canvas-snapshot.ts`, `loro-bridge.ts`,
 * the two projections and the layout all lean on the same guard. Reading
 * through an accessor gives that up: four independent questions, each
 * answerable `undefined`, and nothing that fails when a fifth kind of content
 * arrives unanswered.
 *
 * Dissolving the union removes the concept the guard is over, so this is a
 * cost of decision 3 rather than of these functions. It is written here
 * because the call sites are where someone will notice it, and because the
 * alternative — a discriminant on the resource itself, which would keep an
 * exhaustive switch — is a design decision nobody has taken.
 */

/** The markdown a node shows inline, or `undefined` if it shows none. */
export const nodeText = (node: SpatialNode): string | undefined =>
  node.type === 'text' ? node.text : undefined

/** The document a node points at, or `undefined`. */
export const nodeFile = (node: SpatialNode): string | undefined =>
  node.type === 'file' ? node.file : undefined

/** The external address a node points at, or `undefined`. */
export const nodeUrl = (node: SpatialNode): string | undefined =>
  node.type === 'link' ? node.url : undefined

/**
 * Whether this node is a FRAME — a box drawn behind others that collects
 * whatever its rectangle contains.
 */
export const isFrame = (node: SpatialNode): boolean => node.type === 'group'

/**
 * The same node showing different text.
 *
 * The write counterpart, and it exists for the reason the readers do: today
 * this is `{ ...node, text }`, and under decision 3 it becomes a write into
 * the node's resource. A caller that spells the field is a caller the storage
 * flip has to visit.
 *
 * Answers the node unchanged when it shows no text, so a caller rewriting
 * every node on a canvas needs no `type` check of its own.
 */
export const withNodeText = (node: SpatialNode, text: string): SpatialNode =>
  node.type === 'text' ? { ...node, text } : node

/**
 * The same node pointing at a different document.
 *
 * Drops `subpath` with the old reference, because a fragment identifies a
 * place inside the document it came from and means nothing in another one —
 * the behaviour `commands.ts` already had, moved here so the storage flip
 * finds it in one place.
 */
export const withNodeFile = (node: SpatialNode, file: string): SpatialNode => {
  if (node.type !== 'file') return node
  const { subpath: _dropped, ...rest } = node
  return { ...rest, file }
}

/** The same node pointing at a different address. */
export const withNodeUrl = (node: SpatialNode, url: string): SpatialNode =>
  node.type === 'link' ? { ...node, url } : node

/**
 * A frame's own label, or `undefined` when this node is not a frame.
 *
 * On the frame axis rather than the content one, and here for the same reason
 * `isFrame` is: a caller reading it otherwise has to narrow through `type`,
 * which is the spelling both axes are moving away from.
 */
export const frameLabel = (node: SpatialNode): string | undefined =>
  node.type === 'group' ? node.label : undefined

/** The fragment inside the document a node points at, or `undefined`. */
export const nodeSubpath = (node: SpatialNode): string | undefined =>
  node.type === 'file' ? node.subpath : undefined

/**
 * What KIND of thing a node is: one of the resource kinds, or the frame.
 *
 * The one accessor an exhaustive reader needs. `NodeKind` is closed — the
 * registry's ids plus `'frame'` — so a `switch` over it narrows to `never`
 * and a table written `satisfies Record<NodeKind, …>` fails to compile when
 * the registry grows. That is the guard `searchable-texts.ts` asks for, kept
 * across the dissolution rather than traded for indirection.
 *
 * Today it reads the stored discriminant. After the storage moves it reads
 * `resourceKind(node.resource)`, and no caller changes.
 */
export type NodeKind = ResourceKind | 'frame'

export const nodeKind = (node: SpatialNode): NodeKind =>
  node.type === 'group' ? 'frame' : node.type
