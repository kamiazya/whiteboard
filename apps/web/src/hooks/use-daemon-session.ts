/**
 * What follows from the daemon a session resolved: what the settings store
 * remembers of it, what the replica keeper is told about it, and the stable
 * handle the shell chrome reads it through.
 */
import { useEffect, useMemo } from 'react'
import type { ConnectedDaemon } from '../lib/daemon-auth-fetch.js'
import { passkeySupported } from '../lib/passkey-attestation.js'
import type { UserSettingsStore } from '../lib/user-settings-store.js'

/**
 * Remembers where a `#wb=` pairing landed, so a later hosted-app load (a
 * fresh tab with no fragment) can offer a one-click reconnect through
 * DaemonDetectedBanner instead of silently landing on the browser with no
 * path back.
 *
 * ONLY the reconnect target (baseUrl/workspaceId/path) — never the
 * bootstrapToken, which stays in memory under `readDaemonTokenOnce`'s
 * existing semantics.
 */
export function useRememberedDaemon({
  connected,
  target,
  userSettingsStore,
}: {
  connected: boolean
  target: { baseUrl: string; workspaceId?: string; path?: string } | undefined
  userSettingsStore: UserSettingsStore
}): void {
  useEffect(() => {
    if (!connected || target === undefined) return
    // update() serializes and writes to localStorage synchronously; skip it
    // when the stored target already matches what we would write.
    const stored = userSettingsStore.load().storage
    if (
      stored.daemonBaseUrl === target.baseUrl &&
      stored.lastConnectedWorkspaceId === target.workspaceId &&
      stored.lastConnectedPath === target.path
    ) {
      return
    }
    userSettingsStore.update((current) => ({
      ...current,
      storage: {
        ...current.storage,
        daemonBaseUrl: target.baseUrl,
        lastConnectedWorkspaceId: target.workspaceId,
        lastConnectedPath: target.path,
      },
    }))
    // The connection is a stable module-scope singleton for the life of the
    // tab (see useDaemonConnection.ts) — this runs once per successful
    // pairing, not on every unrelated re-render.
  }, [connected])
}

/**
 * Tells `openDocumentStore` (S4b) which daemon this tab is connected to, so a
 * daemon-kept workspace's replica routes to a real session-key source instead
 * of the withheld answer an unconnected ref gets.
 *
 * `credentials` is read the same way PromoteWorkspaceSection reads it —
 * undefined where WebAuthn is unsupported, so `bindPasskeySession` answers
 * `no-passkey` rather than throwing on a missing API.
 *
 * The store is imported DYNAMICALLY, like every other lib this session only
 * needs once a daemon resolves: a static import pulled the session-key
 * holder's whole chain into App's own critical-path chunk and tripped
 * `smoke:bundle-size`'s modulepreload budget (154.9 KB against a 152 KB
 * budget, measured before this became dynamic).
 */
export function useReplicaKeeper(daemon: ConnectedDaemon | undefined): void {
  useEffect(() => {
    const connected =
      daemon === undefined
        ? null
        : {
            baseUrl: daemon.baseUrl,
            token: daemon.token,
            credentials: passkeySupported() ? globalThis.navigator.credentials : undefined,
          }
    let cancelled = false
    import('../lib/replica-store.js').then(({ connectReplicaKeeper }) => {
      if (!cancelled) connectReplicaKeeper(connected)
    })
    return () => {
      cancelled = true
    }
  }, [daemon?.baseUrl, daemon?.token])
}

/**
 * The daemon the shell chrome talks to, memoised on the two SCALARS rather
 * than on the resolved object — that object is rebuilt every render, and the
 * workspace switcher reads its list in an effect keyed on this source, so a
 * fresh object each render is a fetch each render.
 */
export function useDaemonShellTarget(
  shell: { baseUrl: string; token: string | undefined } | undefined,
): { baseUrl: string; token: string | undefined } | undefined {
  const baseUrl = shell?.baseUrl
  const token = shell?.token
  return useMemo(() => (baseUrl === undefined ? undefined : { baseUrl, token }), [baseUrl, token])
}
