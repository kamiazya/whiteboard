/**
 * What follows from the daemon a session resolved: what the replica keeper is
 * told about it, and the stable handle the shell chrome reads it through.
 */
import { useEffect, useMemo } from 'react'
import type { ConnectedDaemon } from '../lib/daemon-fetch.js'

/**
 * Tells `openDocumentStore` which daemon this tab is connected to, so a
 * daemon-kept workspace's replica routes to a real session-key source instead
 * of the withheld answer an unconnected ref gets.
 *
 * The store is imported DYNAMICALLY, like every other lib this session only
 * needs once a daemon resolves: a static import pulled the session-key
 * holder's whole chain into App's own critical-path chunk and tripped
 * `smoke:bundle-size`'s modulepreload budget (154.9 KB against a 152 KB
 * budget, measured before this became dynamic).
 */
export function useReplicaKeeper(daemon: ConnectedDaemon | undefined): void {
  useEffect(() => {
    const connected = daemon === undefined ? null : { baseUrl: daemon.baseUrl }
    let cancelled = false
    import('../lib/replica-store.js').then(({ connectReplicaKeeper }) => {
      if (!cancelled) connectReplicaKeeper(connected)
    })
    return () => {
      cancelled = true
    }
  }, [daemon?.baseUrl])
}

/**
 * The daemon the shell chrome talks to, memoised on its base URL rather
 * than on the resolved object — that object is rebuilt every render, and the
 * workspace switcher reads its list in an effect keyed on this source, so a
 * fresh object each render is a fetch each render.
 */
export function useDaemonShellTarget(
  shell: ConnectedDaemon | undefined,
): ConnectedDaemon | undefined {
  const baseUrl = shell?.baseUrl
  return useMemo(() => (baseUrl === undefined ? undefined : { baseUrl }), [baseUrl])
}
