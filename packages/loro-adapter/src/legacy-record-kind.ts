import { LoroDoc, VersionVector } from 'loro-crdt'
import { RecordBytesRejectedError, type RecordKind, type VersionOrder } from './record-kind.js'

/** The record a keeper holds while it holds a `LoroDoc`. */
export type LegacyRecord = LoroDoc

function sameVersion(doc: LoroDoc, stored: Uint8Array): boolean {
  return doc.oplogVersion().compare(VersionVector.decode(stored)) === 0
}

function orderOf(doc: LoroDoc, stored: Uint8Array): VersionOrder {
  const order = doc.oplogVersion().compare(VersionVector.decode(stored))
  if (order === undefined) return 'concurrent'
  return order === 0 ? 'equal' : order < 0 ? 'behind' : 'ahead'
}

/**
 * ponytail: records held as a `LoroDoc` until every consumer holds an engine
 * lease; deleted with `loro-crdt` leaving the shipped dependencies.
 */
export const loroDocKind: RecordKind<LegacyRecord> = {
  async load(snapshot, updates) {
    const doc = new LoroDoc()
    try {
      doc.import(snapshot)
      for (const update of updates) doc.import(update)
    } catch (cause) {
      throw new RecordBytesRejectedError(cause)
    }
    return doc
  },
  empty: async () => new LoroDoc(),
  importInto(doc, bytes) {
    doc.import(bytes)
  },
  encodedVersion: (doc) => new Uint8Array(doc.oplogVersion().encode()),
  atVersion: sameVersion,
  compareVersion: orderOf,
  exportUpdateSince: (doc, stored) =>
    new Uint8Array(
      stored === null
        ? doc.export({ mode: 'update' })
        : doc.export({ mode: 'update', from: VersionVector.decode(stored) }),
    ),
  exportSnapshot: (doc) => new Uint8Array(doc.export({ mode: 'snapshot' })),
  release() {
    // A LoroDoc is garbage collected; nothing to give back.
  },
}
