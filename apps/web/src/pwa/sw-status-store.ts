import { getAppLogger } from '../lib/app-logger.js'

const log = getAppLogger('sw-status')

export interface SwStatus {
  /** A service worker registration exists (prod + supporting browser). */
  supported: boolean
  /** A new version is downloaded and waiting for skipWaiting. */
  updateReady: boolean
  /** A manual update check is in flight. */
  checking: boolean
}

// Module-level store rather than React context: the writers live in
// register-sw.ts's registration closures, which run before React mounts and
// outside the tree. Kept dependency-free so importing it never drags SW glue
// into the entry chunk.
let status: SwStatus = { supported: false, updateReady: false, checking: false }
let applyHandler: (() => Promise<void>) | null = null
let checkHandler: (() => Promise<void>) | null = null
const listeners = new Set<() => void>()

function set(next: Partial<SwStatus>): void {
  status = { ...status, ...next }
  for (const listener of listeners) listener()
}

export function subscribeSwStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSwStatus(): SwStatus {
  return status
}

export function bindCheckForUpdates(handler: () => Promise<void>): void {
  checkHandler = handler
  set({ supported: true })
}

export function bindApplyUpdate(handler: () => Promise<void>): void {
  applyHandler = handler
  set({ updateReady: true })
}

export async function checkForUpdates(): Promise<void> {
  if (checkHandler === null || status.checking) return
  set({ checking: true })
  try {
    await checkHandler()
  } catch (err) {
    log.warn('manual service worker update check failed', err)
  } finally {
    set({ checking: false })
  }
}

export async function applyUpdate(): Promise<void> {
  if (applyHandler === null) return
  try {
    await applyHandler()
  } catch (err) {
    log.error('applying the waiting service worker failed', err)
  }
}

export function resetSwStatusForTests(): void {
  status = { supported: false, updateReady: false, checking: false }
  applyHandler = null
  checkHandler = null
  listeners.clear()
}
