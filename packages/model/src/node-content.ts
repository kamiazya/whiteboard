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
