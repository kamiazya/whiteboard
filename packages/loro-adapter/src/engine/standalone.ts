import { bindRecordOps, type RecordSession } from '../record-ops.js'
import { leaseKind } from './lease-kind.js'
import { leaseOps } from './lease-ops.js'
import { loadCrdtEngine } from './load.js'

/** A record opened from bytes, and the call that gives it back. */
export interface StandaloneRecord {
  readonly session: RecordSession
  /** Gives the record back; releasing twice is one release. */
  release(): void
}

/**
 * Opens snapshot bytes as a record of their own on the shared engine, for an
 * operation that judges or reads bytes a request carried and keeps none of
 * them. Nothing is saved from it. Throws `RecordBytesRejectedError` for bytes
 * that are not a document, and rethrows an engine trap as it is, since the
 * bytes may be well-formed.
 */
export async function openStandalone(snapshot: Uint8Array): Promise<StandaloneRecord> {
  const kind = leaseKind(loadCrdtEngine)
  const lease = await kind.load(snapshot, [])
  return { session: bindRecordOps(leaseOps, lease, async () => {}), release: () => lease.release() }
}
