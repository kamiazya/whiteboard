/**
 * What content this device last SAW of a document, per workspace.
 *
 * The card's dot answers "did this change while I was not looking", and the
 * baseline for that is the content the person actually opened.
 *
 * Keyed on `contentDigest`, never `updatedAt`. `document-entry.ts` records
 * what a measurement found: `updatedAt` is a register one replica wrote and
 * a merge does not consult it, so a replica's content became a state nobody
 * had written while its stamp stayed put. A freshness signal built on the
 * stamp can therefore call a document unchanged in the exact case that
 * matters here — an agent rewriting it behind the person's back.
 *
 * Deliberately NOT stored with the recency lane (`recent-documents.ts`),
 * though both are written at the same moment. That one is an ordered list
 * capped at a handful, and a digest riding on it would make the dot vanish
 * for the 9th-oldest document for no reason a person could see.
 */

import { z } from 'zod'
import { ownValue, readScopedStorage, writeScopedStorage } from './scoped-storage.js'

// Namespaced + version-suffixed, like `recent-documents.ts` and
// `user-settings-store.ts`. Disposable in the same way: losing it costs one
// round of dots, so a breaking change here may bump the key with no
// migration.
export const STORAGE_KEY = 'whiteboard:seen-documents:v1'

/**
 * How many documents per workspace keep a baseline.
 *
 * Far above the recency lane's handful, because this record is not a list
 * anyone reads — it is the memory behind a per-card signal, and a document
 * dropping out of it silently loses its dot. Bounded all the same: a
 * workspace is not guaranteed to be small, and localStorage is shared.
 */
export const SEEN_CAP = 500

const storedSchema = z.record(z.string(), z.record(z.string(), z.string()).catch({}))

/**
 * The pure step: `id` recorded at `digest`, evicting the oldest once past
 * the cap.
 *
 * Insertion order is the eviction order, which JS object key order gives for
 * string keys that are not array indices. Document ids are ULIDs, so that
 * holds — and a numeric-looking id would only evict in a different order,
 * never lose the invariant the properties assert.
 */
export function recordSeen(
  existing: Record<string, string>,
  id: string,
  digest: string,
): Record<string, string> {
  const next = { ...existing, [id]: digest }
  const keys = Object.keys(next)
  if (keys.length <= SEEN_CAP) return next
  for (const stale of keys.slice(0, keys.length - SEEN_CAP)) delete next[stale]
  return next
}

export function readSeenDigest(workspace: string, documentId: string): string | undefined {
  const scope = ownValue(readScopedStorage(STORAGE_KEY, storedSchema), workspace)
  return scope === undefined ? undefined : ownValue(scope, documentId)
}

export function recordSeenDocument(workspace: string, documentId: string, digest: string): void {
  const all = readScopedStorage(STORAGE_KEY, storedSchema)
  const next = {
    ...all,
    [workspace]: recordSeen(ownValue(all, workspace) ?? {}, documentId, digest),
  }
  writeScopedStorage(STORAGE_KEY, next)
}
