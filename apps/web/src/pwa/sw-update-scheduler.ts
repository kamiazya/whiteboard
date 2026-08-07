import { getAppLogger } from '../lib/app-logger.js'

const log = getAppLogger('sw-update-scheduler')

// Browsers only byte-check sw.js on their own cadence (typically once per
// navigation), so a long-open or quickly-reloaded tab can go a full deploy
// cycle without ever noticing a new service worker exists. An hourly poll
// plus a check on tab refocus is what turns a deploy into a visible update
// toast without requiring a hard reload or manual unregister.
export const SW_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

type FakeableDocument = Pick<Document, 'addEventListener' | 'removeEventListener'> & {
  visibilityState: DocumentVisibilityState
}

export interface StartSwUpdateSchedulerOptions {
  /** Triggers one service worker update check, e.g. `() => registration.update()`. */
  update: () => Promise<void>
  intervalMs?: number
  doc?: FakeableDocument
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}

export type StopSwUpdateScheduler = () => void

/**
 * Schedules periodic + focus-triggered `update()` checks against a live
 * service worker registration. This module only ever CHECKS for an update —
 * it never swaps the active worker itself. Actually applying an update stays
 * strictly user-initiated via the onNeedRefresh -> UpdateToast flow, per the
 * `registerType: 'prompt'` design intent (never silently swap under a
 * mid-draw user).
 */
export function startSwUpdateScheduler({
  update,
  intervalMs = SW_UPDATE_CHECK_INTERVAL_MS,
  doc = document,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}: StartSwUpdateSchedulerOptions): StopSwUpdateScheduler {
  const checkForUpdate = (): void => {
    // A rejection here (offline, transient network failure) must never
    // become an unhandled rejection or stop future checks — one failed
    // byte-check is not a reason to give up on ever detecting a deploy.
    void update().catch((err: unknown) => {
      log.debug('service worker update check failed', err)
    })
  }

  const intervalId = setIntervalFn(checkForUpdate, intervalMs)

  const onVisibilityChange = (): void => {
    if (doc.visibilityState === 'visible') {
      checkForUpdate()
    }
  }
  doc.addEventListener('visibilitychange', onVisibilityChange)

  return () => {
    clearIntervalFn(intervalId)
    doc.removeEventListener('visibilitychange', onVisibilityChange)
  }
}
