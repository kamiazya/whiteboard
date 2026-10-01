// How a stored node or edge written by an older version of this package is
// read into the model's current shape. Read-only by construction: every
// write converges a record on the current shape the first time it saves, so
// these only ever run on the way OUT of a map.
import { RESOURCE_KINDS } from '@kamiazya/whiteboard-model'

/**
 * The key a canvas's facets, and a node's or edge's facets and embed, were
 * stored under before [ADR-0037](../../../docs/contributing/adr/0037-model-and-format.md):
 * the FORMAT's extension key, because the model was the format.
 *
 * Spelled as it stood, the way a migration's own text always is. It is only
 * ever READ — `liftLegacyExtension` below converts it on the way out, and
 * every write from here on uses the model's own field names, so a record
 * converges the first time anything writes to it.
 */
export const LEGACY_EXTENSION_FIELD = 'x-whiteboard'

/**
 * Convert a stored node or edge written under the old key into the model's
 * shape. A no-op for anything already in it.
 *
 * Load-bearing rather than tidy: the model is `.strict()` now, so a stored
 * node still carrying the old key FAILS its schema, and `readSpatialCanvas`
 * drops what fails to parse — the node would vanish, not merely lose a field.
 */
export function liftLegacyExtension(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw
  const { [LEGACY_EXTENSION_FIELD]: legacy, ...rest } = raw as Record<string, unknown>
  if (legacy === null || typeof legacy !== 'object') return raw
  const extension = legacy as Record<string, unknown>
  const lifted: Record<string, unknown> = { ...rest }
  if (extension.facets !== undefined) lifted.facets = extension.facets
  if (extension.kind === 'embed' && typeof extension.documentId === 'string') {
    lifted.embed = {
      documentId: extension.documentId,
      ...(typeof extension.versionRef === 'string' && { versionRef: extension.versionRef }),
    }
  }
  return lifted
}

/**
 * Convert a stored node written under the pre-[ADR-0038](../../../docs/contributing/adr/0038-ocif-projection.md)
 * node-kind union into the model's shape. A no-op for anything already in it.
 *
 * Load-bearing for the reason `liftLegacyExtension` is, and by the same
 * mechanism: `spatialNodeSchema` is `.strict()` and names neither `type` nor
 * any kind's own content field, so a stored node still carrying them FAILS
 * its schema and `readSpatialCanvas` drops what fails — the node would
 * vanish, not merely lose its content. `legacy-node-kind.test.ts` measures
 * that; nothing else can, since every other test asserts on a document this
 * version wrote.
 *
 * The literals are the shape as it stood, the way a migration's own text
 * always is. Read-only: every write from here on is `nodeToFields`' resource
 * shape, so a record converges the first time anything saves it.
 */
function liftLegacyNodeKind(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw
  const { type, text, file, subpath, url, ...rest } = raw as Record<string, unknown>
  if (type === undefined) return raw
  if (typeof text === 'string') {
    return { ...rest, resource: { mimeType: RESOURCE_KINDS.text.mimeType, content: text } }
  }
  if (typeof file === 'string') {
    return {
      ...rest,
      resource: {
        // A reference alone does not say what it points AT, and the registry
        // claims any located resource that is not a uri-list.
        mimeType: RESOURCE_KINDS.file.mimeType,
        location: file,
        ...(typeof subpath === 'string' && { subpath }),
      },
    }
  }
  if (typeof url === 'string') {
    return { ...rest, resource: { mimeType: RESOURCE_KINDS.link.mimeType, location: url } }
  }
  // A `group` showed nothing, which is exactly what a frame is, and its own
  // fields were already spelled the way the model spells them.
  return rest
}

/** Both lifts, in the order the record acquired the two shapes. */
export function liftStoredNode(raw: unknown): unknown {
  return liftLegacyNodeKind(liftLegacyExtension(raw))
}
