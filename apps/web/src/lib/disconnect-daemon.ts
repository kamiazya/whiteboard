import { disconnectReplicaKeeper } from './replica-store.js'
import type { UserSettingsStore } from './user-settings-store.js'

/**
 * Stop using a daemon in this browser.
 *
 * Deliberately NOT a delete: nothing on the daemon is touched, which is why
 * every surface offering this has to say so — "disconnect" reads like a
 * destructive word.
 *
 * Clearing `daemonBaseUrl` is what makes it outlive the page: App reads that
 * key to decide a cold load reconnects, so leaving it set reconnects on the
 * next visit and "this browser stops using it" becomes false the moment the
 * user reloads.
 */
export function disconnectFromDaemon(store: UserSettingsStore, target: string): void {
  // Held replica keys for this daemon must not keep answering after the
  // browser has stopped using it — a session that outlives its own "stop
  // using this daemon" reads as still connected to whatever asked it. The
  // connection goes with them, synchronously: App only learns of the
  // disconnect on its next render, and a load in between must not mint a
  // replacement key through the session that was just given up.
  disconnectReplicaKeeper(target)
  store.update((current) => {
    const { daemonBaseUrl, ...storage } = current.storage
    return {
      ...current,
      storage: {
        ...storage,
        // Another daemon's stored target is none of this call's business.
        ...(daemonBaseUrl === target ? {} : { daemonBaseUrl }),
      },
    }
  })
}
