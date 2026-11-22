import { leaseOps, loadCrdtEngine, type RecordOps } from '@kamiazya/whiteboard-loro-adapter'
import { type IndexRecordKind, leaseIndexKind } from '@kamiazya/whiteboard-workspace-index'

/**
 * What the daemon holds a workspace record as, with everything that depends on
 * the answer in one place: how a record is loaded, saved and compared, the
 * operations a session runs over it, how many stay resident, and how long an
 * unused one is kept.
 *
 * The cache and the store hold records as `object` and never learn what they
 * hold; the casts that erase the record's own type are here and only here.
 */
export interface WorkspaceRecordKind {
  readonly index: IndexRecordKind<object>
  readonly ops: RecordOps<object>
  /** How many records stay resident, the least recently used dropped first. */
  readonly maxEntries: number
  /** How long an unused record is kept before it is given back. */
  readonly idleMs: number
}

/**
 * A record is an engine lease: its document lives in the engine's own memory
 * until it is released, so a few stay resident and an unused one is given back
 * after a while. `scripts/measure/workspace-concurrency-memory.mjs` puts four
 * held 360-document workspaces at about 124MB over baseline (45MB for the
 * `LoroDoc` this replaced), and the bound of four caps that however many
 * workspaces are touched.
 * Releasing returns the memory to the engine for reuse rather than to the OS
 * (80MB stayed resident after four releases), so what the idle time bounds is
 * growth, not the resident size after a busy hour.
 */
export const LEASE_IDLE_MS = 5 * 60_000

export const WORKSPACE_RECORD_KIND: WorkspaceRecordKind = {
  index: leaseIndexKind(loadCrdtEngine) as unknown as IndexRecordKind<object>,
  ops: leaseOps as unknown as RecordOps<object>,
  maxEntries: 4,
  idleMs: LEASE_IDLE_MS,
}
