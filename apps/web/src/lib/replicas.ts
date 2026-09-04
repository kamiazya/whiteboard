/**
 * Lookup over the replica registry (storage.replicas) by whatever name an
 * address carries. The registry keys by the CANONICAL workspace id, but a
 * URL usually carries the segment — and offline, the segment cannot be
 * resolved against the daemon, which is why each entry captured it at sync
 * time.
 */
import type { UserSettings } from './user-settings-store.js'

export interface ReplicaEntryInput {
  daemonBaseUrl: string
  syncedAt: string
  segment?: string
  displayName?: string
  /** Base64 VersionVector of what the daemon is known to hold. */
  syncedFrontier?: string
}

/**
 * The registry's one writer, shared by the background refresh and the
 * post-promote registration so the two cannot shape an entry differently.
 */
export function withReplicaEntry(
  current: UserSettings,
  workspaceId: string,
  entry: ReplicaEntryInput,
): UserSettings {
  return {
    ...current,
    storage: {
      ...current.storage,
      replicas: {
        ...current.storage.replicas,
        [workspaceId]: {
          // Merge over the existing entry: a writer that only knows the
          // sync fields must not drop the offline-lookup fields (segment,
          // displayName) some earlier writer captured.
          ...current.storage.replicas?.[workspaceId],
          daemonBaseUrl: entry.daemonBaseUrl,
          syncedAt: entry.syncedAt,
          ...(entry.segment === undefined ? {} : { segment: entry.segment }),
          ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }),
          ...(entry.syncedFrontier === undefined ? {} : { syncedFrontier: entry.syncedFrontier }),
        },
      },
    },
  }
}

export interface ReplicaMatch {
  /** The canonical daemon workspace id — the registry key and record key. */
  workspaceId: string
  daemonBaseUrl: string
  syncedAt: string
  segment?: string
  displayName?: string
  syncedFrontier?: string
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
