import type { LoroDoc } from 'loro-crdt'

// key: "workspaceId/path"
//
// LRU eviction keeps LoroDoc memory from growing without bound across many
// documents or during long daemon uptime. One canvas can hold several MiB
// of CRDT history, so cap the cache at 32 entries. This uses Map insertion order as
// the minimal implementation with no extra dependency.
//
// This module imports nothing of its own: the store passes `getOrLoad` the
// loader to call on a miss, rather than the cache reaching back into it.
// That is what keeps `document-store.ts` — which must evict after operations
// that replace on-disk state — free of an import cycle with this file.
//
// Caveat: WS handlers may keep live doc references. Evicting a canvas that still has
// active connections could leave callers mutating an old doc instance. In practice,
// documents with active WS connections should stay recently touched and remain on the
// hot side of the LRU.
const CACHE_MAX_SIZE = 32
const cache = new Map<string, LoroDoc>()

function touch(key: string, doc: LoroDoc): void {
  // Reinsert existing keys so they move to the end of insertion order (= MRU).
  cache.delete(key)
  cache.set(key, doc)
  // When over capacity, evict the oldest key (the head of insertion order).
  while (cache.size > CACHE_MAX_SIZE) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/**
 * Read through the cache, calling `load` only on a miss. The loader is a
 * parameter rather than an import so this module stays a leaf; see
 * `getDoc` in document-store.ts for the one caller that supplies it.
 */
export async function getOrLoad(
  workspaceId: string,
  path: string,
  load: () => Promise<LoroDoc>,
): Promise<LoroDoc> {
  const key = `${workspaceId}/${path}`
  const existing = cache.get(key)
  if (existing) {
    touch(key, existing)
    return existing
  }
  const doc = await load()
  touch(key, doc)
  return doc
}

// Test helper: clear the cache.
export function clearCache(): void {
  cache.clear()
}

// Evict a doc after operations such as compact or rename that replace on-disk state,
// forcing the next getDoc call to reload it.
// Callers already holding a live doc reference, such as WS handlers, do not get swapped
// automatically. getDoc is safe because it always consults the cache first.
export function evictDoc(workspaceId: string, path: string): void {
  cache.delete(`${workspaceId}/${path}`)
}

// Evict every cached doc of one workspace. Needed after a workspace-
// granularity import: it rewrites document content underneath every cached
// per-document projection at once, and a stale projection is worse than a
// stale doc — the next per-document save would diff the OLD content against
// the tree and silently revert the imported edit.
export function evictWorkspaceDocs(workspaceId: string): void {
  const prefix = `${workspaceId}/`
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

// /debug helper: list cached canvas keys ("workspaceId/path").
export function getCacheKeys(): string[] {
  return Array.from(cache.keys())
}

// /debug helper: read a LoroDoc from cache without populating it.
export function peekDoc(workspaceId: string, path: string): LoroDoc | undefined {
  return cache.get(`${workspaceId}/${path}`)
}
