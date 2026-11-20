/**
 * The return half of ADR-0023 decision 3's offline edits: ops the replica
 * took while its keeper was unreachable, shipped back as an ordinary CRDT
 * update through the same idempotent merge endpoint the whole-workspace
 * promote posts to. The daemon imports; nothing is replaced.
 *
 * `syncedFrontier` is the registry's claim of what the daemon already
 * holds (recorded by the pull, from the pulled bytes alone). With it, the
 * payload is exactly the ops past that point — and a replica with nothing
 * past it ships NOTHING, so the caller may invoke this on every daemon
 * resolve without pricing a request. Without it (an entry from before
 * offline edits existed), one full snapshot goes across; the merge makes
 * that safe, and the result's frontier ends the snapshot era for good.
 *
 * A plain function behind the lazy chunks, like replica-cache.ts: it
 * reaches the CRDT engine, so nothing on the entry path may import this file
 * statically (entry-graph-loro-free.test.ts guards the closure).
 */
import { workspaceDocumentApiUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/document-url'
import { reach } from '@kamiazya/whiteboard-daemon-client/api-contracts/read-body'
import { compareVersions } from '@kamiazya/whiteboard-history'
import { lease, type RecordLease } from '@kamiazya/whiteboard-loro-adapter'
import { base64ToBytes, bytesToBase64 } from '@kamiazya/whiteboard-model'
import type { WorkspaceRecords } from '@kamiazya/whiteboard-workspace-index'
import { getAppLogger } from './app-logger.js'
import {
  describeTransferFailure,
  PUSH_FAILURE_COPY,
  type TransferFailure,
} from './keeper-transfer-failure.js'

const log = getAppLogger('replica-push')

export interface PushReplicaEditsOptions {
  fetch: typeof globalThis.fetch
  daemonBaseUrl: string
  /** The daemon workspace the replica mirrors — the KEEPER's id. */
  workspaceId: string
  /** The browser's own planes (production: `new BrowserWorkspaceRecords()`). */
  workspaceDocs: WorkspaceRecords
  /** Base64 version vector of what the daemon is known to hold. */
  syncedFrontier?: string
}

export type PushReplicaEditsResult =
  | { kind: 'clean' }
  | { kind: 'ok'; syncedAt: string; syncedFrontier: string }
  | TransferFailure

/** A version as the per-peer counters `compareVersions` reads. */
function countersOf(entries: readonly { peer: string; counter: number }[]) {
  return new Map(entries.map(({ peer, counter }) => [peer, counter]))
}

/** What the daemon lacks of the record, or `null` when it lacks nothing. */
function payloadFor(record: RecordLease, syncedFrontier: string | undefined): Uint8Array | null {
  // A marker that does not decode is as good as none: the whole record is
  // sent, which the daemon's CRDT import absorbs idempotently.
  const syncedBytes = syncedFrontier === undefined ? null : base64ToBytes(syncedFrontier)
  if (syncedBytes === null) return lease.exportSnapshot(record)
  const synced = record.engine.decode({ kind: 'version', bytes: bytesToBase64(syncedBytes) })
  const order = compareVersions(
    countersOf(lease.versionOf(record).entries),
    countersOf(synced.entries),
  )
  // The record within the synced point: the daemon already holds everything local.
  if (order === 'equal' || order === 'before') return null
  return lease.exportUpdateSince(record, syncedBytes)
}

async function pushRecord(
  { fetch, daemonBaseUrl, workspaceId, syncedFrontier }: PushReplicaEditsOptions,
  record: RecordLease,
): Promise<PushReplicaEditsResult> {
  const current = lease.versionOf(record).encoded
  const payload = payloadFor(record, syncedFrontier)
  if (payload === null) return { kind: 'clean' }
  const res = await reach(
    fetch(`${daemonBaseUrl}${workspaceDocumentApiUrl(workspaceId, 'update')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: payload as BodyInit,
    }),
  )
  if (!res.ok) return { kind: 'failed', reason: `Update request failed (${res.status}).` }
  return {
    kind: 'ok',
    syncedAt: new Date().toISOString(),
    syncedFrontier: bytesToBase64(current),
  }
}

export async function pushReplicaEdits(
  options: PushReplicaEditsOptions,
): Promise<PushReplicaEditsResult> {
  const { daemonBaseUrl, workspaceId, workspaceDocs } = options
  try {
    const record = await workspaceDocs.open(workspaceId)
    if (record === null) return { kind: 'clean' }
    try {
      return await pushRecord(options, record)
    } finally {
      record.release()
    }
  } catch (err) {
    return describeTransferFailure(err, PUSH_FAILURE_COPY, {
      log,
      fields: { daemonBaseUrl, workspaceId },
    })
  }
}
