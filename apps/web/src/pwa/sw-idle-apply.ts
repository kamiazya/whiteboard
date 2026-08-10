import { getAppLogger } from '../lib/app-logger.js'

const log = getAppLogger('sw-idle-apply')

/**
 * How long the tab must stay hidden before the swap is taken.
 *
 * Long enough that a quick tab switch does not trigger a reload the user
 * returns into, and long enough to cover the editor's debounced write window
 * so nothing in flight is lost.
 */
export const SW_IDLE_SETTLE_MS = 5_000

export interface StartSwIdleAutoApplyOptions {
  /** Applies the waiting worker. This reloads the page. */
  readonly apply: () => void
  /** Caller's "nothing in flight" signal; defaults to always idle. */
  readonly isIdle?: () => boolean
  readonly doc?: Document
}

export type StopSwIdleAutoApply = () => void

/**
 * Takes a waiting service worker update at the one moment it costs nothing:
 * while the tab is hidden.
 *
 * The prompt strategy exists so an update never swaps under someone mid-draw,
 * and that reasoning does not apply to a tab nobody is looking at. Without
 * this, an update waits for a click that a user with no reason to care about
 * versions may never give — and the page keeps running old code indefinitely,
 * which is how a fix that shipped can look like a fix that was never written.
 *
 * Returning before the settle period cancels the swap: that is someone
 * switching tabs, not leaving, and the reload would land as they come back.
 */
export function startSwIdleAutoApply({
  apply,
  isIdle = () => true,
  doc = document,
}: StartSwIdleAutoApplyOptions): StopSwIdleAutoApply {
  let pending: ReturnType<typeof setTimeout> | undefined

  const cancel = (): void => {
    if (pending === undefined) return
    clearTimeout(pending)
    pending = undefined
  }

  const onVisibilityChange = (): void => {
    if (doc.visibilityState !== 'hidden') {
      cancel()
      return
    }
    cancel()
    pending = setTimeout(() => {
      pending = undefined
      // Re-checked rather than trusted from when the timer was set: both can
      // change during the settle period, and applying then would reload a
      // visible tab or drop work that arrived meanwhile.
      if (doc.visibilityState !== 'hidden' || !isIdle()) return
      log.debug('applying the waiting service worker while the tab is hidden')
      apply()
    }, SW_IDLE_SETTLE_MS)
  }

  doc.addEventListener('visibilitychange', onVisibilityChange)
  return () => {
    cancel()
    doc.removeEventListener('visibilitychange', onVisibilityChange)
  }
}
