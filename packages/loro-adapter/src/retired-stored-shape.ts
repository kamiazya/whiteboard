// Shapes an older version of this package stored and no reader serves any
// more. Nothing here converts one: a record still holding a retired shape is
// REFUSED by name, because with no reader left the honest alternatives are
// both silent — the `.strict()` model drops an element it cannot parse, and
// an absent key reads as "nothing here". Today: a node, edge or canvas in the
// pre-ADR-0037/0038 forms, a markdown body stored as a canvas text node, and
// the Excalidraw `elements` list.

import { documentKindSchema } from '@kamiazya/whiteboard-model'
import { type ContainerID, LoroDoc, type LoroMap } from 'loro-crdt'
import {
  CANVAS_KEY,
  DOCUMENT_KEY,
  type DocumentContainers,
  EDGES_KEY,
  MARKDOWN_BODY_KEY,
  NODES_KEY,
  RETIRED_ELEMENTS_KEY,
} from './containers.js'

/**
 * The key a canvas's facets, and a node's or edge's facets and embed, were
 * stored under before [ADR-0037](../../../docs/contributing/adr/0037-model-and-format.md):
 * the FORMAT's extension key, because the model was the format. Spelled as it
 * stood; only the JSON Canvas projection still writes it, never the record.
 */
const PRE_ADR_0037_EXTENSION_KEY = 'x-whiteboard'

/**
 * A document holding a shape this version no longer reads. The bytes stay
 * where they are; the caller says so rather than showing the document
 * without what the shape carried.
 */
export class RetiredStoredShapeError extends Error {
  readonly code = 'retired_stored_shape'

  constructor(readonly found: string) {
    super(
      `this document holds ${found}, saved by an older version in a form this version no longer reads; its data has not been changed`,
    )
    this.name = 'RetiredStoredShapeError'
  }
}

const recordOf = (raw: unknown): Record<string, unknown> | undefined =>
  raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined

/**
 * The node-kind union before [ADR-0038](../../../docs/contributing/adr/0038-ocif-projection.md)
 * decision 3, by its discriminant's four values. Only those: a `type` this
 * build never wrote is a NEWER writer's, skipped like any record the schema
 * refuses rather than refused as old.
 */
const PRE_ADR_0038_NODE_KINDS: ReadonlySet<unknown> = new Set(['text', 'file', 'link', 'group'])

/** What retired shape one stored node value is in, or null. */
export function retiredNodeShape(id: string, raw: unknown): string | null {
  const value = recordOf(raw)
  if (value === undefined) return null
  if (value[PRE_ADR_0037_EXTENSION_KEY] !== undefined) {
    return `node "${id}" stored under the pre-ADR-0037 \`${PRE_ADR_0037_EXTENSION_KEY}\` key`
  }
  if (PRE_ADR_0038_NODE_KINDS.has(value.type)) {
    return `node "${id}" stored in the pre-ADR-0038 node-kind union (type "${String(value.type)}")`
  }
  return null
}

/** What retired shape one stored edge value is in, or null. */
export function retiredEdgeShape(id: string, raw: unknown): string | null {
  return recordOf(raw)?.[PRE_ADR_0037_EXTENSION_KEY] === undefined
    ? null
    : `edge "${id}" stored under the pre-ADR-0037 \`${PRE_ADR_0037_EXTENSION_KEY}\` key`
}

/** Whether the canvas map still holds its facets under the pre-ADR-0037 key. */
export function retiredCanvasShape(canvasMap: LoroMap): string | null {
  return canvasMap.get(PRE_ADR_0037_EXTENSION_KEY) === undefined
    ? null
    : `canvas settings stored under the pre-ADR-0037 \`${PRE_ADR_0037_EXTENSION_KEY}\` key`
}

/**
 * The id of the single text node an older `document.set` stored a markdown
 * body in, inside the spatial canvas. Spelled as it stood; nothing writes it,
 * and a document still holding one is refused (below).
 */
const RETIRED_BODY_NODE_ID = 'okf-body'

/**
 * Whether this document's body is still the retired `okf-body` text node: an
 * empty container beside it. A container with text is the current body
 * whatever else the canvas holds, so only the empty one could hide prose.
 * Opens no container on a tree host.
 */
function retiredMarkdownBodyShape(doc: DocumentContainers): string | null {
  const nodes = doc.peekMap === undefined ? doc.getMap(NODES_KEY) : doc.peekMap(NODES_KEY)
  if (nodes?.get(RETIRED_BODY_NODE_ID) === undefined) return null
  return doc.getText(MARKDOWN_BODY_KEY).length > 0
    ? null
    : `a markdown body stored as the \`${RETIRED_BODY_NODE_ID}\` canvas text node`
}

/**
 * A MARKDOWN document with an empty body whose canvas holds a node carrying
 * text: a body an older writer stored as a text node under some other id,
 * before `okf-body` was stable. Asked only where the kind is known, since on
 * a spatial document a text node is content.
 */
export function retiredMarkdownCanvasShape(doc: DocumentContainers): string | null {
  if (doc.getText(MARKDOWN_BODY_KEY).length > 0) return null
  const nodes = doc.peekMap === undefined ? doc.getMap(NODES_KEY) : doc.peekMap(NODES_KEY)
  const holdsText = (nodes?.values() ?? []).some(
    (raw) => typeof recordOf(recordOf(raw)?.resource)?.content === 'string',
  )
  return holdsText ? 'a markdown body stored as a canvas text node' : null
}

/** Throws `RetiredStoredShapeError` for a shape a check above found. */
export function refuseRetiredShape(found: string | null): void {
  if (found !== null) throw new RetiredStoredShapeError(found)
}

/** The first entry of `map` in a retired shape, or null. */
export function firstRetired(
  map: LoroMap | undefined,
  shapeOf: (id: string, raw: unknown) => string | null,
): string | null {
  if (map === undefined) return null
  for (const id of map.keys()) {
    const found = shapeOf(id, map.get(id))
    if (found !== null) return found
  }
  return null
}

const peekMap = (doc: DocumentContainers, key: string): LoroMap | undefined =>
  doc.peekMap === undefined ? doc.getMap(key) : doc.peekMap(key)

/**
 * The body checks, asked by the document's recorded kind: none of a spatial
 * document, since a canvas edit may legitimately mint the body node's id
 * and a text node is content there; the body-node check of an unrecorded
 * kind, since the shape dates from before kinds were written; both of a
 * markdown document. Opens no container.
 */
export function retiredMarkdownShape(doc: DocumentContainers): string | null {
  const kind = documentKindSchema.safeParse(peekMap(doc, DOCUMENT_KEY)?.get('kind'))
  if (kind.success && kind.data === 'spatial') return null
  return (
    retiredMarkdownBodyShape(doc) ??
    (kind.success && kind.data === 'markdown' ? retiredMarkdownCanvasShape(doc) : null)
  )
}

/**
 * Whether the retired Excalidraw `elements` list still holds entries. An
 * empty root is what an old client leaves by merely opening it and carries
 * nothing, so only entries are refused. Opens nothing: on a LoroDoc even
 * asking for a root that was never there registers it, so the root is looked
 * up in the shallow value first and fetched by the container id listed
 * there. A host that is neither a LoroDoc nor offers `peekList` holds none.
 */
export function retiredElementsShape(doc: DocumentContainers): string | null {
  let held: { readonly length: number } | undefined
  if (doc.peekList !== undefined) {
    held = doc.peekList(RETIRED_ELEMENTS_KEY)
  } else if (doc instanceof LoroDoc) {
    const cid = doc.getShallowValue()[RETIRED_ELEMENTS_KEY]
    if (typeof cid === 'string' && (cid.endsWith(':MovableList') || cid.endsWith(':List'))) {
      const container = doc.getContainerById(cid as ContainerID)
      held = container as { readonly length: number } | undefined
    }
  }
  return held !== undefined && held.length > 0
    ? `canvas elements stored as the retired Excalidraw \`${RETIRED_ELEMENTS_KEY}\` list (${held.length} entries)`
    : null
}

/**
 * The first retired shape this document holds, or null — for a caller that
 * must decide before it reads (a snapshot arriving in an editor), where the
 * readers would throw part-way through. Opens no container: a tree node
 * opens one by WRITING it.
 */
export function retiredStoredShapeIn(doc: DocumentContainers): string | null {
  const canvasMap = peekMap(doc, CANVAS_KEY)
  return (
    firstRetired(peekMap(doc, NODES_KEY), retiredNodeShape) ??
    firstRetired(peekMap(doc, EDGES_KEY), retiredEdgeShape) ??
    (canvasMap === undefined ? null : retiredCanvasShape(canvasMap)) ??
    retiredMarkdownShape(doc) ??
    retiredElementsShape(doc)
  )
}
