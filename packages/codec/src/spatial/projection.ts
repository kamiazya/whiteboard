import type { CanvasEdge, SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { JsonCanvasDocument, JsonCanvasEdge, JsonCanvasNode } from './json-canvas.js'

/** What a field position costs when a document is projected onto JSON Canvas. */
export type FieldProjection =
  /** JSON Canvas 1.0 states it. Survives every mode, strict included. */
  | { readonly kind: 'native' }
  /** Carried on `x-whiteboard`. Survives `extended`; strict mode drops it. */
  | { readonly kind: 'extension' }
  /** Crosses as something else. `to` names what a reader gets instead. */
  | { readonly kind: 'degraded'; readonly to: string }
  /** Cannot cross at all. `why` says what about the format refuses it. */
  | { readonly kind: 'dropped'; readonly why: string }

const NATIVE = { kind: 'native' } as const
const EXTENSION = { kind: 'extension' } as const

/**
 * Every field position the model can hold, and what projecting it onto JSON
 * Canvas costs. The model no longer spells the format's key anywhere, so this
 * table is the ONLY place that says which side of the line a field is on.
 *
 * This is the rung that replaces the one the format used to supply. While the
 * model IS the format, a field cannot be added without the format accepting
 * it, so nobody has to think about the export. ADR-0033 removes that refusal
 * deliberately — and a model free to grow, with nothing forcing anyone to say
 * what growing costs a reader who only speaks JSON Canvas, is the failure mode
 * that change would otherwise create.
 *
 * `projection.test.ts` holds it in the four directions of
 * `.claude/rules/coverage-ledger.md` against the census's own path list, and
 * checks the `extension` half against what `strictDegrade` really drops — a
 * declaration nothing compares to behaviour is a claim, not a guard.
 */
export const JSON_CANVAS_PROJECTION: Readonly<Record<string, FieldProjection>> = {
  // JSON Canvas 1.0's own vocabulary.
  'nodes[].id': NATIVE,
  'nodes[].type': NATIVE,
  'nodes[].x': NATIVE,
  'nodes[].y': NATIVE,
  'nodes[].width': NATIVE,
  'nodes[].height': NATIVE,
  'nodes[].color': NATIVE,
  'nodes[].text': NATIVE,
  'nodes[].file': NATIVE,
  'nodes[].subpath': NATIVE,
  'nodes[].url': NATIVE,
  'nodes[].label': NATIVE,
  'nodes[].background': NATIVE,
  'nodes[].backgroundStyle': NATIVE,
  'edges[].id': NATIVE,
  'edges[].fromNode': NATIVE,
  'edges[].toNode': NATIVE,
  'edges[].fromSide': NATIVE,
  'edges[].toSide': NATIVE,
  'edges[].fromEnd': NATIVE,
  'edges[].toEnd': NATIVE,
  'edges[].color': NATIVE,
  'edges[].label': NATIVE,

  // An embedded document: the one piece of CONTENT the format cannot hold, so
  // a strict reader sees the node and not what it shows.
  'nodes[].embed.documentId': EXTENSION,
  'nodes[].embed.versionRef': EXTENSION,

  // The annotation layer (ADR-0024). A strict reader keeps the whole content
  // and loses the conversation about it, which is what an annotation is.
  'comments[].id': EXTENSION,
  'comments[].x': EXTENSION,
  'comments[].y': EXTENSION,
  'comments[].text': EXTENSION,
  'comments[].author': EXTENSION,
  'comments[].createdAt': EXTENSION,
  'comments[].targetNodeId': EXTENSION,
  'comments[].targetEdgeId': EXTENSION,
  'comments[].resolved': EXTENSION,

  // The facet buckets (ADR-0013). Counted as buckets rather than descended:
  // the format can say one is present and nothing about what is in it, and a
  // plugin's payloads are not this table's to enumerate.
  'facets/*': EXTENSION,
  'nodes[].facets/*': EXTENSION,
  'edges[].facets/*': EXTENSION,
}

export interface LossEntry {
  readonly path: string
  readonly projection: FieldProjection
}

/**
 * What a reader loses, as data rather than prose — the published half of
 * decision 2's promise. Every position that does NOT survive strict JSON
 * Canvas, so a caller can show it before someone picks an export mode.
 */
export function jsonCanvasLoss(): readonly LossEntry[] {
  return Object.entries(JSON_CANVAS_PROJECTION)
    .filter(([, projection]) => projection.kind !== 'native')
    .map(([path, projection]) => ({ path, projection }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * The leaf positions a VALUE actually occupies, in the census's notation, so
 * a declaration can be compared against what a projection really did. A
 * facets bucket collapses to one `/*` entry for the reason the schema census
 * does not descend it.
 *
 * The collapse is by NAME here and structural in the census (an object schema
 * with no properties). They agree today because `facets` names an open record
 * at all three sites and nowhere else, and the collapse fires at the FIRST
 * `facets` key, so a plugin payload that happens to hold one of its own is
 * never reached. A field later named `facets` that is not an open record would
 * make the two notations disagree — which fails the comparison above loudly
 * rather than hiding a loss, so this is a maintenance cost and not a hole.
 */
export function valueLeafPaths(value: unknown): readonly string[] {
  const out: string[] = []
  walkValue(value, '', out)
  return [...new Set(out)].sort()
}

function walkValue(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) walkValue(item, `${path}[]`, out)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue
      const next = path === '' ? key : `${path}.${key}`
      if (key === 'facets') {
        out.push(`${next}/*`)
        continue
      }
      walkValue(child, next, out)
    }
    return
  }
  out.push(path)
}

/**
 * Project a document onto JSON Canvas.
 *
 * Written out field by field rather than spread, on purpose: a model field
 * added without a projection decision then fails the round-trip property
 * instead of riding along unnoticed. That is the same guard the ledger gives,
 * arrived at from the other side — one checks the declaration, the other
 * checks the code.
 *
 * The decomposition reaches INTO the extension object at every site, not only
 * the top level. It did not at first, and the comment above was then true of
 * top-level fields and false of the embed and facet buckets — which is most of
 * what the extension side actually holds, so the stated mechanism covered
 * almost none of the fields it was written for.
 *
 * Where it stops is a facet PAYLOAD, deliberately: its contents belong to a
 * plugin, the format can only say the bucket is there, and the ledger says
 * exactly that.
 */
export function toJsonCanvas(canvas: SpatialCanvas): JsonCanvasDocument {
  const extension = {
    ...(canvas.comments !== undefined && { comments: canvas.comments }),
    ...(canvas.facets !== undefined && { facets: canvas.facets }),
  }
  return {
    nodes: canvas.nodes.map(projectNode),
    edges: canvas.edges.map(projectEdge),
    // An extension object with nothing in it is not emitted. That is a
    // canonicalisation, not a loss — `x-whiteboard: {}` says exactly what its
    // absence says — and it is the one place the wire round-trip normalises
    // rather than preserves, pinned by its own example below the property.
    ...(Object.keys(extension).length > 0 && { 'x-whiteboard': extension }),
  }
}

/**
 * Read a JSON Canvas document back as a document. Every JSON Canvas 1.0
 * document is a valid one, which is what makes the format an import path and
 * not only an export one.
 */
export function fromJsonCanvas(document: JsonCanvasDocument): SpatialCanvas {
  const extension = document['x-whiteboard']
  return {
    nodes: document.nodes.map(liftNode),
    edges: document.edges.map(liftEdge),
    ...(extension?.comments !== undefined && { comments: extension.comments }),
    ...(extension?.facets !== undefined && { facets: extension.facets }),
  }
}

function liftNode(node: JsonCanvasNode): SpatialNode {
  const extension = node['x-whiteboard']
  const embed =
    extension !== undefined && 'kind' in extension
      ? {
          documentId: extension.documentId,
          ...(extension.versionRef !== undefined && { versionRef: extension.versionRef }),
        }
      : undefined
  const shared = {
    id: node.id,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    ...(node.color !== undefined && { color: node.color }),
    ...(embed !== undefined && { embed }),
    ...(extension?.facets !== undefined && { facets: extension.facets }),
  }
  switch (node.type) {
    case 'text':
      return { ...shared, type: 'text', text: node.text }
    case 'file':
      return {
        ...shared,
        type: 'file',
        file: node.file,
        ...(node.subpath !== undefined && { subpath: node.subpath }),
      }
    case 'link':
      return { ...shared, type: 'link', url: node.url }
    case 'group':
      return {
        ...shared,
        type: 'group',
        ...(node.label !== undefined && { label: node.label }),
        ...(node.background !== undefined && { background: node.background }),
        ...(node.backgroundStyle !== undefined && { backgroundStyle: node.backgroundStyle }),
      }
  }
}

function liftEdge(edge: JsonCanvasEdge): CanvasEdge {
  return {
    id: edge.id,
    fromNode: edge.fromNode,
    toNode: edge.toNode,
    ...(edge.fromSide !== undefined && { fromSide: edge.fromSide }),
    ...(edge.toSide !== undefined && { toSide: edge.toSide }),
    ...(edge.fromEnd !== undefined && { fromEnd: edge.fromEnd }),
    ...(edge.toEnd !== undefined && { toEnd: edge.toEnd }),
    ...(edge.color !== undefined && { color: edge.color }),
    ...(edge.label !== undefined && { label: edge.label }),
    ...(edge['x-whiteboard']?.facets !== undefined && { facets: edge['x-whiteboard'].facets }),
  }
}

function projectNode(node: SpatialNode): JsonCanvasNode {
  const shared = {
    id: node.id,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    ...(node.color !== undefined && { color: node.color }),
    ...(nodeExtension(node) !== undefined && { 'x-whiteboard': nodeExtension(node) }),
  }
  switch (node.type) {
    case 'text':
      return { ...shared, type: 'text', text: node.text }
    case 'file':
      return {
        ...shared,
        type: 'file',
        file: node.file,
        ...(node.subpath !== undefined && { subpath: node.subpath }),
      }
    case 'link':
      return { ...shared, type: 'link', url: node.url }
    case 'group':
      return {
        ...shared,
        type: 'group',
        ...(node.label !== undefined && { label: node.label }),
        ...(node.background !== undefined && { background: node.background }),
        ...(node.backgroundStyle !== undefined && { backgroundStyle: node.backgroundStyle }),
      }
  }
}

function projectEdge(edge: CanvasEdge): JsonCanvasEdge {
  return {
    id: edge.id,
    fromNode: edge.fromNode,
    toNode: edge.toNode,
    ...(edge.fromSide !== undefined && { fromSide: edge.fromSide }),
    ...(edge.toSide !== undefined && { toSide: edge.toSide }),
    ...(edge.fromEnd !== undefined && { fromEnd: edge.fromEnd }),
    ...(edge.toEnd !== undefined && { toEnd: edge.toEnd }),
    ...(edge.color !== undefined && { color: edge.color }),
    ...(edge.label !== undefined && { label: edge.label }),
    // An edge's extension is the facets-only arm and nothing else: an edge has
    // no content JSON Canvas cannot express.
    ...(edge.facets !== undefined && { 'x-whiteboard': { facets: edge.facets } }),
  }
}

/**
 * A node's extension, or nothing when the node has neither half.
 *
 * The format makes an embed and a facets bucket two ARMS of a union, so a node
 * carrying both is spelled as the embed arm with facets inside it. The model
 * has no such constraint — the arms were the format's shape, not a choice
 * anything needed — so the two independent fields fold back into one arm here.
 */
function nodeExtension(node: SpatialNode): JsonCanvasNode['x-whiteboard'] {
  if (node.embed !== undefined) {
    return {
      kind: 'embed',
      documentId: node.embed.documentId,
      ...(node.embed.versionRef !== undefined && { versionRef: node.embed.versionRef }),
      ...(node.facets !== undefined && { facets: node.facets }),
    }
  }
  if (node.facets !== undefined) return { facets: node.facets }
  return undefined
}
