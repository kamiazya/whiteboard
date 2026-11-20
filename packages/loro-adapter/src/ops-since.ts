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
 */
export function opsSince(doc: LoroDoc, since: VersionVector): JsonOp[] {
  const held = since.toJSON()
  const head = doc.oplogVersion()
  try {
    const ops: JsonOp[] = []
    for (const [peer, end] of head.toJSON()) {
      const start = held.get(peer) ?? 0
      if (end <= start) continue
      const changes = doc.exportJsonInIdSpan({ peer, counter: start, length: end - start })
      for (const change of changes) ops.push(...change.ops)
    }
    return ops
  } finally {
    head.free()
  }
}
