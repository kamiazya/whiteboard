import { createCrdtEngine } from './engine.js'
import type { CrdtEngine } from './types.js'

let shared: CrdtEngine | undefined

/**
 * The one engine of this realm, created on first use and then shared, so a
 * lease taken through one accessor is valid through the other.
 *
 * Synchronous because the engine module is already in this package's static
 * graph (the entry exports `createCrdtEngine`) and `loro-crdt` is imported
 * statically by every sibling: nothing is left to fetch. A caller that holds
 * this entry has therefore already paid for the wasm, and the bundle-size
 * boundary is the one that keeps the entry itself off the first-paint path.
 */
export function sharedCrdtEngine(): CrdtEngine {
  shared ??= createCrdtEngine()
  return shared
}

/** The same engine as `sharedCrdtEngine`, for a caller that is already asynchronous. */
export async function loadCrdtEngine(): Promise<CrdtEngine> {
  return sharedCrdtEngine()
}
