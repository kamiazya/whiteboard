/**
 * Persistent-storage guard for browser-local documents. Without an explicit
 * StorageManager.persist() grant, the IndexedDB holding every browser-local
 * canvas is best-effort — the browser may evict it under storage pressure,
 * which would silently delete user data the product promises stays on their
 * machine. Chromium grants silently based on engagement, Firefox may
 * prompt, Safari manages persistence itself (API absent → null).
 */

export async function queryPersistentStorage(): Promise<boolean | null> {
  const storage = navigator.storage
  if (storage?.persisted === undefined) return null
  try {
    return await storage.persisted()
  } catch {
    return null
  }
}

/** Request persistence if not yet granted. true/false = grant state, null = unsupported. */
export async function ensurePersistentStorage(): Promise<boolean | null> {
  const storage = navigator.storage
  if (storage?.persist === undefined) return null
  try {
    if (await storage.persisted?.()) return true
    return await storage.persist()
  } catch {
    return null
  }
}
