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

/**
 * Every copy this device keeps a registry claim for.
 *
 * The Settings list of local copies cannot be built from the byte store —
 * `IdbDocumentStore` has no list method — so the inventory is this registry
 * plus the browser workspace rows, which are disjoint: a replica never gets
 * a `workspaces` row.
 */
export function listReplicas(settings: UserSettings): ReplicaMatch[] {
  const replicas = settings.storage.replicas
  if (replicas === undefined) return []
  return Object.entries(replicas).map(([workspaceId, entry]) => ({ workspaceId, ...entry }))
}

/**
 * Drops one workspace's registry claim. The FIRST of the two steps a delete
 * takes, and never the whole delete: this record's own schema says a missing
 * entry means "claim no cache", not "the bytes are gone", so the caller
 * deletes the record too.
 *
 * Claim first, bytes second — the order `demoteBrowserWorkspace` takes, for
 * its reason: a failure between the two leaves bytes nothing points at,
 * which the next pull overwrites, whereas the reverse leaves a claim
 * pointing at a record that is gone and every reader of it has to cope.
 */
export function forgetReplicaEntry(current: UserSettings, workspaceId: string): UserSettings {
  const replicas = current.storage.replicas
  if (replicas?.[workspaceId] === undefined) return current
  const { [workspaceId]: _dropped, ...rest } = replicas
  return { ...current, storage: { ...current.storage, replicas: rest } }
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
