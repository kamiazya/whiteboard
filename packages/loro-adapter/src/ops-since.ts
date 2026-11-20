import type { JsonOp, LoroDoc, VersionVector } from 'loro-crdt'

/**
 * The operations `doc` holds beyond `since`, read as the span each peer wrote.
 *
 * `exportJsonUpdates` between two versions answers the same operations but
 * costs by how many peers the record has seen (measured: 13 ms against 0.05 ms
 * for one write on a record of 500), and a workspace record opened under a new
 * peer each time has seen as many as it has been opened. A span is read by the
 * peer and counters it covers. Only the operations' containers and contents
 * are the same as an export's: a tree move's `parent` is absent here where an
 * export spells it `null`.
 *
 * A compacted record no longer holds its earliest operations, and a span that
 * starts at one of them reads nothing at all. Each span therefore starts no
 * earlier than the history the record kept, which is where an export starts.
 */
export function opsSince(doc: LoroDoc, since: VersionVector): JsonOp[] {
  const held = since.toJSON()
  const head = doc.oplogVersion()
  const kept = doc.shallowSinceVV()
  try {
    const keptFrom = kept.toJSON()
    const ops: JsonOp[] = []
    for (const [peer, end] of head.toJSON()) {
      const start = Math.max(held.get(peer) ?? 0, keptFrom.get(peer) ?? 0)
      if (end <= start) continue
      const changes = doc.exportJsonInIdSpan({ peer, counter: start, length: end - start })
      for (const change of changes) ops.push(...change.ops)
    }
    return ops
  } finally {
    head.free()
    kept.free()
  }
}
