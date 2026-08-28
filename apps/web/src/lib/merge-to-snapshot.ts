import { Loro } from 'loro-crdt'

/**
 * Collapses a Loro snapshot plus its delta log into one combined snapshot —
 * a true deep copy with no shared reference to the source's bytes or its
 * underlying LoroDoc. The duplicate path feeds a fresh document from this.
 */
export function mergeToSnapshot(snapshot: Uint8Array, deltas: Uint8Array[]): Uint8Array {
  const doc = new Loro()
  doc.import(snapshot)
  for (const delta of deltas) doc.import(delta)
  return doc.export({ mode: 'snapshot' })
}
