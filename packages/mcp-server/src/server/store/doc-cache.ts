import type { LoroDoc } from 'loro-crdt'
import { loadCanvas, saveCanvas } from './canvas-store.js'

// key: "workspaceId/slug"
//
// LRU eviction keeps LoroDoc memory from growing without bound across many
// canvases or during long daemon uptime. One canvas can hold several MiB
// of CRDT history, so cap the cache at 32 entries. This uses Map insertion order as
// the minimal implementation with no extra dependency.
//
// Caveat: WS handlers may keep live doc references. Evicting a canvas that still has
// active connections could leave callers mutating an old doc instance. In practice,
// canvases with active WS connections should stay recently touched and remain on the
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

export async function getDoc(workspaceId: string, slug: string): Promise<LoroDoc> {
  const key = `${workspaceId}/${slug}`
  const existing = cache.get(key)
  if (existing) {
    touch(key, existing)
    return existing
  }
  const doc = await loadCanvas(workspaceId, slug)
  touch(key, doc)
  return doc
}

export async function applyAndPersist(
  workspaceId: string,
  slug: string,
  updater: (doc: LoroDoc) => void,
): Promise<Uint8Array> {
  const doc = await getDoc(workspaceId, slug)
  const prevVV = doc.version()
  updater(doc)
  await saveCanvas(workspaceId, slug, doc, { overwrite: true })
  // Return the incremental update that was applied so it can be broadcast over WS.
  return doc.export({ mode: 'update', from: prevVV })
}

// Test helper: clear the cache.
export function clearCache(): void {
  cache.clear()
}

// Evict a doc after operations such as compact or rename that replace on-disk state,
// forcing the next getDoc call to reload it.
// Callers already holding a live doc reference, such as WS handlers, do not get swapped
// automatically. applyAndPersist is safe because it always calls getDoc first.
export function evictDoc(workspaceId: string, slug: string): void {
  cache.delete(`${workspaceId}/${slug}`)
}

// /debug helper: list cached canvas keys ("workspaceId/slug").
export function getCacheKeys(): string[] {
  return Array.from(cache.keys())
}

// /debug helper: read a LoroDoc from cache without populating it.
export function peekDoc(workspaceId: string, slug: string): LoroDoc | undefined {
  return cache.get(`${workspaceId}/${slug}`)
}
