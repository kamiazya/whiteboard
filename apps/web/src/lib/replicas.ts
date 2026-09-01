/**
 * Lookup over the replica registry (storage.replicas) by whatever name an
 * address carries. The registry keys by the CANONICAL workspace id, but a
 * URL usually carries the segment — and offline, the segment cannot be
 * resolved against the daemon, which is why each entry captured it at sync
 * time.
 */
import type { UserSettings } from './user-settings-store.js'

export interface ReplicaMatch {
  /** The canonical daemon workspace id — the registry key and record key. */
  workspaceId: string
  daemonBaseUrl: string
  syncedAt: string
  segment?: string
  displayName?: string
}

export function findReplicaForHandle(settings: UserSettings, handle: string): ReplicaMatch | null {
  const replicas = settings.storage.replicas
  if (replicas === undefined) return null
  for (const [workspaceId, entry] of Object.entries(replicas)) {
    if (workspaceId === handle || entry.segment === handle) {
      return { workspaceId, ...entry }
    }
  }
  return null
}
