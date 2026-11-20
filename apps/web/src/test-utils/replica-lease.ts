/**
 * A replica record in the form the page holds it, built from the `LoroDoc` a
 * fixture is easiest to write against, and read back the same way.
 */
import {
  lease,
  leaseKind,
  loadCrdtEngine,
  type RecordLease,
} from '@kamiazya/whiteboard-loro-adapter'
import { LoroDoc } from 'loro-crdt'

const kind = leaseKind(loadCrdtEngine)

export function leaseOf(doc: LoroDoc): Promise<RecordLease> {
  return kind.load(doc.export({ mode: 'snapshot' }), [])
}

/** A copy of the record's present state, for a test to read with the adapter's own readers. */
export function docOf(record: RecordLease): LoroDoc {
  const doc = new LoroDoc()
  doc.import(lease.exportSnapshot(record))
  return doc
}
