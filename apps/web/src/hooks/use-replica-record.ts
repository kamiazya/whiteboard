/**
 * Opens this workspace's stored replica for the offline page: the record and
 * its entries, or the reason there is none.
 */
import type { WithheldReason } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import { useEffect } from 'react'
import { BrowserWorkspaceRecords } from '../lib/browser-workspace-records.js'
import type { WorkspaceDocumentEntry } from '../lib/document-entry.js'
import { type ReplicaRecord, replicaEntries } from '../lib/replica-record.js'
import { forgetWithdrawnReplica, replicaKeyStatus } from '../lib/replica-store.js'
import { ReplicaKeyRotatedError, ReplicaKeyWithheldError } from '../lib/sealed-document-store.js'

export type LoadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'rotated' }
  | { kind: 'withheld'; reason: WithheldReason }
  | { kind: 'ready'; record: ReplicaRecord; entries: WorkspaceDocumentEntry[] }

/**
 * What a failed open means. A rotated key comes first, ahead of the generic
 * arm that would call the copy missing: the bytes are there and intact, sealed
 * under a key that is gone. A withheld key reads the holder's cached reason
 * rather than believing 'unreachable' by default — the whole point of the
 * removed state is that a daemon-refused key reads as removed, not as an
 * ordinary disconnection.
 */
function loadFailureState(
  error: unknown,
  daemonBaseUrl: string,
  workspaceId: string,
  precheck: ReturnType<typeof replicaKeyStatus>,
): LoadState {
  if (error instanceof ReplicaKeyRotatedError) return { kind: 'rotated' }
  if (!(error instanceof ReplicaKeyWithheldError)) return { kind: 'missing' }
  const status = replicaKeyStatus(daemonBaseUrl, workspaceId)
  const reason =
    status?.kind === 'withheld'
      ? status.reason
      : precheck?.kind === 'withheld'
        ? precheck.reason
        : 'unreachable'
  return { kind: 'withheld', reason }
}

/**
 * Opens this workspace's stored replica and says what came back: the record
 * and its entries, a withheld reason, or nothing at all. Re-runs on an
 * `attempt` bump, which is how Reconnect and Unlock re-enter the SAME open
 * path a cold load takes rather than a bespoke retry.
 */
export function useReplicaRecord({
  workspaceId,
  daemonBaseUrl,
  attempt,
  withheld,
  setState,
  settled,
}: {
  workspaceId: string
  daemonBaseUrl: string
  attempt: number
  withheld: WithheldReason | undefined
  setState: (state: LoadState) => void
  /** Resolves once every save of the held record has ended (`ReplicaSaveQueue.settled`). */
  settled: () => Promise<void>
}): void {
  useEffect(() => {
    let cancelled = false
    let held: ReplicaRecord | null = null
    setState({ kind: 'loading' })
    // The daemon already answered directly (a live-daemon membership
    // refusal, not a replica-key holder verdict) — never open the record at
    // all. Without this branch a removed member with no replica record on
    // this device would read as 'needs-connection' rather than 'removed'.
    if (withheld !== undefined) {
      forgetWithdrawnReplica(daemonBaseUrl, workspaceId, withheld)
      setState({ kind: 'withheld', reason: withheld })
      return
    }
    // Read BEFORE the open, not only after: a lapsed entry is what
    // `open()` itself will discover (`sessionKey`'s own lapse check runs
    // inside the store's `keyFor`), and that check CLEARS the cache entry
    // the moment it fires — so a status read taken only in the catch below
    // would already find nothing and report 'unreachable', losing the one
    // reason the lapsed state exists to show. The two never disagree when
    // both are defined; this one is only load-bearing for a reason that
    // vanishes between the two reads.
    const precheck = replicaKeyStatus(daemonBaseUrl, workspaceId)
    // `open`, never `create`: a replica the registry promises but the store
    // lost must render as missing, not be minted empty — an empty record
    // under the daemon's id would read as the daemon's data being gone.
    void new BrowserWorkspaceRecords()
      .open(workspaceId)
      .then((record) => {
        if (cancelled) {
          record?.release()
          return
        }
        if (record === null) {
          setState({ kind: 'missing' })
          return
        }
        held = record
        const entries = replicaEntries(record)
        setState({ kind: 'ready', record, entries })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState(loadFailureState(error, daemonBaseUrl, workspaceId, precheck))
      })
    return () => {
      cancelled = true
      // The queue may still hold a save of this record; it is given back only
      // once that save has ended.
      const done = held
      if (done !== null) void settled().then(() => done.release())
    }
  }, [workspaceId, daemonBaseUrl, attempt, withheld, settled])
}
