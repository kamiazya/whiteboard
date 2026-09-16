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
import { RESOURCE_KINDS, type ResourceKind, resourceKind } from './node-resource.js'
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
  node.resource !== undefined && resourceKind(node.resource) === 'text'
    ? node.resource.content
    : undefined

/** The document a node points at, or `undefined`. */
export const nodeFile = (node: SpatialNode): string | undefined =>
  node.resource !== undefined && resourceKind(node.resource) === 'file'
    ? node.resource.location
    : undefined

/** The external address a node points at, or `undefined`. */
export const nodeUrl = (node: SpatialNode): string | undefined =>
  node.resource !== undefined && resourceKind(node.resource) === 'link'
    ? node.resource.location
    : undefined

/** The fragment inside the document a node points at, or `undefined`. */
export const nodeSubpath = (node: SpatialNode): string | undefined =>
  nodeFile(node) === undefined ? undefined : node.resource?.subpath

/**
 * Whether this node is a FRAME — a box drawn behind others that collects
 * whatever its rectangle contains.
 *
 * A frame shows nothing, so it is the node with no resource. That is the same
 * thing the `group` arm said and the same thing OCIF's group node says.
 */
export const isFrame = (node: SpatialNode): boolean => node.resource === undefined

/**
 * A frame's own label, or `undefined` when this node is not a frame.
 */
export const frameLabel = (node: SpatialNode): string | undefined =>
  isFrame(node) ? node.label : undefined

/**
 * The image a frame is painted with, and how it is fitted — `undefined` when
 * this node is not a frame, or names none.
 *
 * Beside `frameLabel` for the same reason and on the same axis: these are the
 * last two stored fields a caller could only reach by narrowing.
 */
export const frameBackground = (node: SpatialNode): string | undefined =>
  isFrame(node) ? node.background : undefined

export const frameBackgroundStyle = (
  node: SpatialNode,
): 'cover' | 'ratio' | 'repeat' | undefined => (isFrame(node) ? node.backgroundStyle : undefined)

/**
 * What KIND of thing a node is: one of the resource kinds, or the frame.
 *
 * `undefined` means the node shows content this build has no reader for —
 * a resource whose media type nothing in `RESOURCE_KINDS` claims. The
 * node-kind union could not express that at all: an unknown arm failed to
 * parse and the whole node was dropped. A caller that must answer for every
 * node answers for this case too.
 */
export type NodeKind = ResourceKind | 'frame'

export const nodeKind = (node: SpatialNode): NodeKind | undefined =>
  node.resource === undefined ? 'frame' : resourceKind(node.resource)

/**
 * The same node showing different text.
 *
 * Answers the node unchanged when it shows no text, so a caller rewriting
 * every node on a canvas needs no kind check of its own.
 */
export const withNodeText = (node: SpatialNode, text: string): SpatialNode =>
  nodeText(node) === undefined
    ? node
    : {
        ...node,
        resource: { ...node.resource, mimeType: RESOURCE_KINDS.text.mimeType, content: text },
      }

/**
 * The same node pointing at a different document.
 *
 * Drops `subpath` with the old reference, because a fragment identifies a
 * place inside the document it came from and means nothing in another one.
 */
export const withNodeFile = (node: SpatialNode, file: string): SpatialNode => {
  const resource = node.resource
  if (resource === undefined || resourceKind(resource) !== 'file') return node
  const { subpath: _dropped, ...rest } = resource
  return { ...node, resource: { ...rest, location: file } }
}

/** The same node pointing at a different address. */
export const withNodeUrl = (node: SpatialNode, url: string): SpatialNode =>
  nodeUrl(node) === undefined
    ? node
    : {
        ...node,
        resource: { ...node.resource, mimeType: RESOURCE_KINDS.link.mimeType, location: url },
      }
