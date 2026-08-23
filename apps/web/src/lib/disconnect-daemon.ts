import type { UserSettingsStore } from './user-settings-store.js'

/**
 * Stop using a daemon in this browser.
 *
 * Deliberately NOT an unpair and NOT a delete: nothing on the daemon is
 * touched and the pairing stays valid, which is why every surface offering
 * this has to say so — "disconnect" reads like a destructive word.
 *
 * Lives here rather than at its call site because the two writes are a pair
 * and only make sense together:
 *
 * - Clearing `daemonBaseUrl` is what makes it outlive the page. App.tsx
 *   reads that key to decide a load is daemon-backed, so leaving it set
 *   reconnects on the next visit and "this browser stops using it" becomes
 *   false the moment the user reloads.
 * - Recording the dismissal is what stops discovery undoing it. The default
 *   port range is rescanned on every visit, so forgetting alone would bring
 *   the same daemon straight back and the action would read as a no-op.
 */
export function disconnectFromDaemon(store: UserSettingsStore, target: string): void {
  store.update((current) => {
    const known = (current.storage.knownDaemonBaseUrls ?? []).filter((entry) => entry !== target)
    const dismissed = (current.storage.dismissedDaemonBaseUrls ?? []).filter(
      (entry) => entry !== target,
    )
    const { daemonBaseUrl, ...storage } = current.storage
    return {
      ...current,
      storage: {
        ...storage,
        // Another daemon's stored target is none of this call's business.
        ...(daemonBaseUrl === target ? {} : { daemonBaseUrl }),
        knownDaemonBaseUrls: known,
        // Bounded: this is a "skip these" hint, not an archive.
        dismissedDaemonBaseUrls: [target, ...dismissed].slice(0, 5),
      },
    }
  })
}
