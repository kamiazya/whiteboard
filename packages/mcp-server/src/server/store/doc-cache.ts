import { LoroDoc } from 'loro-crdt'
import { globalStoreScope, type StoreScope } from './store-scope.js'

// key: "<dataDir>::workspaceId/path". The data dir is part of it because the
// cache is process-wide while a store is not: two stores over different
// directories holding the same workspace id and path would otherwise be
// served each other's documents.
//
// LRU eviction keeps LoroDoc memory from growing without bound across many
// documents or during long daemon uptime. One document can hold several MiB
// of CRDT history, so cap the cache at 32 entries. This uses Map insertion order as
// the minimal implementation with no extra dependency.
//
// This module imports no store module but the scope: the store passes
// `getOrLoad` the loader to call on a miss, rather than the cache reaching
// back into it.
// That is what keeps `document-store.ts` — which must evict after operations
// that replace on-disk state — free of an import cycle with this file.
//
// Caveat: update handlers may keep live doc references. Evicting a document that still has
// active sync streams could leave callers mutating an old doc instance. In practice,
// documents with active sync streams should stay recently touched and remain on the
// hot side of the LRU.
const CACHE_MAX_SIZE = 32
const cache = new Map<string, LoroDoc>()

function keyOf(scope: StoreScope, workspaceId: string, path: string): string {
  return `${workspacePrefix(scope, workspaceId)}${path}`
}

function workspacePrefix(scope: StoreScope, workspaceId: string): string {
  return `${scope.dataDir}::${workspaceId}/`
}

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

// One in-flight load per key. Two concurrent misses would otherwise each
// mint their OWN doc instance, one writer would keep using the instance the
// other's overwrote out of the cache, and their next saves would silently
// clobber each other — a split-brain the LRU alone cannot prevent.
const pendingLoads = new Map<string, { promise: Promise<LoroDoc>; aborted: boolean }>()

// The empty documents handed out for a path the store placed nothing at,
// each mapped to the key it was handed out under. Weak, so a stand-in nobody
// saves is collected with its reader.
const standIns = new WeakMap<LoroDoc, string>()

/**
 * Read through the cache, calling `load` only on a miss — and only ONCE per
 * concurrent miss. The loader is a parameter rather than an import so this
 * module stays a leaf; see `getDoc` in document-store.ts for the one caller
 * that supplies it.
 *
 * A loader answers `null` when nothing is stored at the path, and the caller
 * is handed an empty stand-in that is NOT cached. The key is a path, and a
 * path that holds nothing can come to hold a document by any placement — a
 * restore from the trash, a duplicate, a move, a create; an empty document
 * cached before one of them would be served in the placed one's stead, and
 * the next save through it would write the emptiness over the placed
 * content. Not caching it is what spares every placement from having to
 * remember to evict. The one way a stand-in enters the cache is by being
 * SAVED at its path (`settleSavedDoc`), when it is the placed document.
 */
export async function getOrLoad(
  workspaceId: string,
  path: string,
  load: () => Promise<LoroDoc | null>,
  scope: StoreScope = globalStoreScope,
): Promise<LoroDoc> {
  const key = keyOf(scope, workspaceId, path)
  const existing = cache.get(key)
  if (existing) {
    touch(key, existing)
    return existing
  }
  const inFlight = pendingLoads.get(key)
  if (inFlight) return inFlight.promise
  const entry = {
    aborted: false,
    promise: Promise.resolve().then(async () => {
      try {
        const doc = await load()
        if (doc === null) return standInFor(key)
        // An eviction that raced the load means the loaded state may already
        // be stale — hand it to the caller that asked, but do not cache it.
        if (!entry.aborted) touch(key, doc)
        return doc
      } finally {
        if (pendingLoads.get(key) === entry) pendingLoads.delete(key)
      }
    }),
  }
  pendingLoads.set(key, entry)
  return entry.promise
}

function standInFor(key: string): LoroDoc {
  const doc = new LoroDoc()
  standIns.set(doc, key)
  return doc
}

/**
 * Bring the cache in line with a save of `doc` at `path`, which has just
 * placed `doc`'s content there.
 *
 * A cached instance other than `doc` is behind that content (the caller
 * saved a fresh import or a checkout clone) and is evicted. A stand-in for
 * this path becomes the cached instance: it IS the placed document now, and
 * the writer that saved it — an open page sending its first update — goes on
 * sending deltas built on its history, which a projection reloaded from the
 * tree would not share.
 */
export function settleSavedDoc(
  workspaceId: string,
  path: string,
  doc: LoroDoc,
  scope: StoreScope = globalStoreScope,
): void {
  const key = keyOf(scope, workspaceId, path)
  const cached = cache.get(key)
  if (cached !== undefined) {
    if (cached !== doc) evictDoc(workspaceId, path, scope)
    return
  }
  if (standIns.get(doc) !== key) return
  standIns.delete(doc)
  // A read that raced this save would otherwise land a projection over it.
  abortPendingLoad(key)
  touch(key, doc)
}

function abortPendingLoad(key: string): void {
  const entry = pendingLoads.get(key)
  if (entry) {
    entry.aborted = true
    pendingLoads.delete(key)
  }
}

// Test helper: clear the cache.
export function clearDocCacheForTests(): void {
  cache.clear()
  for (const key of Array.from(pendingLoads.keys())) abortPendingLoad(key)
}

// Evict a doc after operations such as compact or rename that replace on-disk state,
// forcing the next getDoc call to reload it.
// Callers already holding a live doc reference, such as update handlers, do not get swapped
// automatically. getDoc is safe because it always consults the cache first.
export function evictDoc(
  workspaceId: string,
  path: string,
  scope: StoreScope = globalStoreScope,
): void {
  const key = keyOf(scope, workspaceId, path)
  cache.delete(key)
  abortPendingLoad(key)
}

// Evict every cached doc of one workspace. Needed after a workspace-
// granularity import: it rewrites document content underneath every cached
// per-document projection at once, and a stale projection is worse than a
// stale doc — the next per-document save would diff the OLD content against
// the tree and silently revert the imported edit.
export function evictWorkspaceDocs(
  workspaceId: string,
  scope: StoreScope = globalStoreScope,
): void {
  const prefix = workspacePrefix(scope, workspaceId)
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
  for (const key of Array.from(pendingLoads.keys())) {
    if (key.startsWith(prefix)) abortPendingLoad(key)
  }
}

// /debug helper: list cached document keys ("workspaceId/path") of one store.
export function getCacheKeys(scope: StoreScope = globalStoreScope): string[] {
  const own = `${scope.dataDir}::`
  return Array.from(cache.keys())
    .filter((key) => key.startsWith(own))
    .map((key) => key.slice(own.length))
}

// /debug helper: read a LoroDoc from cache without populating it.
export function peekDoc(
  workspaceId: string,
  path: string,
  scope: StoreScope = globalStoreScope,
): LoroDoc | undefined {
  return cache.get(keyOf(scope, workspaceId, path))
}
