/**
 * The one guarded `localStorage`. A browser that blocks storage (privacy
 * settings, an embedded or sandboxed context) raises on the `localStorage`
 * property itself, before any method is called, and a full quota raises on
 * write — so a bare access can fail the action it merely decorates. Every
 * caller here treats persistence as a convenience: a throwing storage reads
 * as an empty one and loses writes, and none of these functions throws.
 *
 * A caller that must tell "unavailable" from "empty" cannot use these; none
 * does today. `local-storage-surface.test.ts` keeps this the only module that
 * touches the global.
 */

export function safeGetItem(key: string): string | null {
  try {
    return globalThis.localStorage.getItem(key)
  } catch {
    return null
  }
}

export function safeSetItem(key: string, value: string): void {
  try {
    globalThis.localStorage.setItem(key, value)
  } catch {
    // An unwritable storage degrades to not remembering.
  }
}

export function safeRemoveItem(key: string): void {
  try {
    globalThis.localStorage.removeItem(key)
  } catch {
    // Nothing to remove from a storage that cannot be reached.
  }
}
