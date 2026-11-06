// Shapes an older version of this package stored and no reader serves any
// more. Nothing here converts one: a record still holding a retired shape is
// REFUSED by name, because with no reader left the honest alternatives are
// both silent — the `.strict()` model drops an element it cannot parse, and
// an absent key reads as "nothing here".
import type { LoroMap } from 'loro-crdt'
import { CANVAS_KEY, type DocumentContainers, EDGES_KEY, NODES_KEY } from './containers.js'

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

/** Throws `RetiredStoredShapeError` for a shape a check above found. */
export function refuseRetiredShape(found: string | null): void {
  if (found !== null) throw new RetiredStoredShapeError(found)
}

function firstRetired(
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

/**
 * The first retired shape this document holds, or null — for a caller that
 * must decide before it reads (a snapshot arriving in an editor), where the
 * readers would throw part-way through. Opens no container: a tree node
 * opens one by WRITING it.
 */
export function retiredStoredShapeIn(doc: DocumentContainers): string | null {
  const peek = (key: string) => (doc.peekMap === undefined ? doc.getMap(key) : doc.peekMap(key))
  const canvasMap = peek(CANVAS_KEY)
  return (
    firstRetired(peek(NODES_KEY), retiredNodeShape) ??
    firstRetired(peek(EDGES_KEY), retiredEdgeShape) ??
    (canvasMap === undefined ? null : retiredCanvasShape(canvasMap))
  )
}
