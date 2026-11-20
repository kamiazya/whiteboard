import {
  bindRecordOps,
  leaseKind,
  leaseOps,
  loadCrdtEngine,
  type RecordSession,
} from '@kamiazya/whiteboard-loro-adapter'

/**
 * A workspace record opened from a snapshot as an engine lease, bound to its
 * operations the way a promote holds the record it was sent. Nothing is saved
 * from it, and the handle lives until the engine does, which a test's own
 * engine ends with the file.
 */
export async function leasedSession(snapshot: Uint8Array): Promise<RecordSession> {
  const lease = await leaseKind(loadCrdtEngine).load(snapshot, [])
  return bindRecordOps(leaseOps, lease, async () => {})
}
