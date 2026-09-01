/**
 * Persistent-storage guard for documents kept in this browser. Without an explicit
 * StorageManager.persist() grant, the IndexedDB holding every browser-kept
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

export interface BrowserStorageEstimate {
  usageBytes: number
  quotaBytes: number
}

/**
 * What this browser reports it is keeping for the app, and the room it
 * offers. null = the API is absent (or answered without numbers), so the
 * UI simply shows no figure rather than a zero that would read as "empty".
 */
export async function queryStorageEstimate(): Promise<BrowserStorageEstimate | null> {
  const storage = navigator.storage
  if (storage?.estimate === undefined) return null
  try {
    const { usage, quota } = await storage.estimate()
    if (typeof usage !== 'number' || typeof quota !== 'number') return null
    return { usageBytes: usage, quotaBytes: quota }
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
