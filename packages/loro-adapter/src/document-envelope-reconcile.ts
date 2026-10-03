// The envelope's visible-diff writes. An edit that started from what a reader
// answered applies itself here, and so never deletes an entry the reader
// dropped: a newer client's facet, core field or canvas facet this build's
// grammar refuses. A delete is a CRDT op that ships to every replica, so
// resyncing a bucket from a lossy read would erase that client's data
// everywhere. `writeFacets`/`writeCoreFacets` state the whole truth instead,
// which is right for the one caller that replaces a document wholesale.
import {
  type ExtensionFacets,
  extensionFacetsSchema,
  type StoredCoreFacets,
} from '@kamiazya/whiteboard-model'
import {
  CANVAS_KEY,
  CORE_KEY,
  type DocumentContainers,
  FACETS_KEY,
  type Fields,
} from './containers.js'
import { LEGACY_EXTENSION_FIELD } from './legacy-lifts.js'

/** The canvas's own facets, one key of the canvas map so its LWW is per-key. */
export const CANVAS_FACETS_FIELD = 'facets'

/** Equal as stored: the same reference, or the same JSON. */
export const sameValue = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * The one definition of a facet key this build can read. Taken from the
 * schema rather than restated, so the readers and the writers below agree on
 * which entries are the ones they must leave alone.
 */
export function isReadableFacetKey(key: string): boolean {
  return extensionFacetsSchema.safeParse({ [key]: null }).success
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/**
 * Make a bucket equal `next` given it currently reads as `prev`: set what is
 * new or changed, delete only a key `prev` held and `next` lacks. An entry the
 * reader never showed is in neither, so it is never touched.
 */
function reconcileBucket(
  doc: DocumentContainers,
  mapKey: string,
  prev: Fields,
  next: Fields,
): void {
  const map = doc.getMap(mapKey)
  const wanted = Object.entries(next).filter(([, value]) => value !== undefined)
  const kept = new Set(wanted.map(([key]) => key))
  for (const [key, value] of wanted) {
    if (!sameValue(prev[key], value)) map.set(key, value as Parameters<typeof map.set>[1])
  }
  for (const key of Object.keys(prev)) if (!kept.has(key)) map.delete(key)
  doc.commit()
}

/** `prev` is `readFacets` as the edit began, `next` what the edit leaves. */
export function reconcileFacets(
  doc: DocumentContainers,
  prev: ExtensionFacets,
  next: ExtensionFacets,
): void {
  reconcileBucket(doc, FACETS_KEY, prev, next)
}

/** `prev` is `readCoreFacets` as the edit began (`undefined` when none was stored). */
export function reconcileCoreFacets(
  doc: DocumentContainers,
  prev: StoredCoreFacets | undefined,
  next: StoredCoreFacets,
): void {
  reconcileBucket(doc, CORE_KEY, { ...prev }, { ...next })
}

/** The stored canvas facets bucket, from this version's key or the one before it. */
function storedCanvasFacets(doc: DocumentContainers): Record<string, unknown> | undefined {
  const canvasMap = doc.getMap(CANVAS_KEY)
  // The legacy value came from another version or peer, so it is read as
  // untrusted: an unreadable payload costs the preference, never the canvas.
  return (
    asRecord(canvasMap.get(CANVAS_FACETS_FIELD)) ??
    asRecord(asRecord(canvasMap.get(LEGACY_EXTENSION_FIELD))?.facets)
  )
}

/**
 * The canvas's facets this build can read.
 *
 * Per key, like `readFacets`: one key outside the grammar costs that entry and
 * nothing beside it. A bucket with entries and none readable answers
 * `undefined`, as one with none stored does.
 */
export function readCanvasFacets(doc: DocumentContainers): ExtensionFacets | undefined {
  const stored = storedCanvasFacets(doc)
  if (stored === undefined) return undefined
  const entries = Object.entries(stored)
  const readable = entries.filter(([key]) => isReadableFacetKey(key))
  return readable.length === 0 && entries.length > 0 ? undefined : Object.fromEntries(readable)
}

/** How many stored canvas facet entries `readCanvasFacets` could not read. */
export function countUnreadableCanvasFacets(doc: DocumentContainers): number {
  return Object.keys(storedCanvasFacets(doc) ?? {}).filter((key) => !isReadableFacetKey(key)).length
}

/**
 * Store the canvas's facets as the editor now sees them, keeping the stored
 * entries the reader skipped. The bucket is one LWW value, so a write that
 * stated only the visible entries would replace a newer client's facet with
 * nothing. An empty result removes the field.
 */
export function writeCanvasFacetsField(
  doc: DocumentContainers,
  next: ExtensionFacets | undefined,
): void {
  const canvasMap = doc.getMap(CANVAS_KEY)
  const unreadable = Object.entries(asRecord(canvasMap.get(CANVAS_FACETS_FIELD)) ?? {}).filter(
    ([key]) => !isReadableFacetKey(key),
  )
  const merged = { ...Object.fromEntries(unreadable), ...next }
  if (Object.keys(merged).length === 0) canvasMap.delete(CANVAS_FACETS_FIELD)
  else canvasMap.set(CANVAS_FACETS_FIELD, merged as Parameters<typeof canvasMap.set>[1])
}
