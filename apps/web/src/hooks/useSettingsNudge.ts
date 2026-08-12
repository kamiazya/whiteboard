import { useEffect, useState, useSyncExternalStore } from 'react'
import { getInstallState, subscribeInstallState } from '@/lib/install-prompt-store'
import { queryPersistentStorage } from '@/lib/persistent-storage'
import { getSwStatus, subscribeSwStatus } from '../pwa/sw-status-store.js'

/**
 * Whether the settings gear should carry the blue attention dot: an
 * ACTIONABLE setup-journey step remains (persistence grantable but not
 * granted, an install prompt captured, no daemon connected) or a service
 * worker update is waiting to apply. Blocked steps — persistence the browser
 * manages itself, installs with no captured prompt — never light it: a dot
 * the user cannot extinguish is noise, not a nudge.
 */
export function useSettingsNudge(daemonConnected: boolean): boolean {
  const install = useSyncExternalStore(subscribeInstallState, getInstallState)
  const sw = useSyncExternalStore(subscribeSwStatus, getSwStatus)
  // false until the query answers: the dot must not flash on while the
  // persistence state is still unknown.
  const [persistTodo, setPersistTodo] = useState(false)
  useEffect(() => {
    let cancelled = false
    void queryPersistentStorage().then((state) => {
      if (!cancelled) setPersistTodo(state === false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return persistTodo || install.status === 'installable' || sw.updateReady || !daemonConnected
}
