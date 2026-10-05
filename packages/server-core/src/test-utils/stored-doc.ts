import { LoroDoc } from 'loro-crdt'

/**
 * A cache over a stored snapshot: `evict` drops the instance, `get` rebuilds
 * from what was saved. A sync refusal evicts rather than saving, so "nothing
 * was kept" is observable as what the next read finds, not only as a save
 * that did not run.
 */
export class StoredDoc {
  private stored: Uint8Array
  private cached: LoroDoc | null = null
  saves = 0
  evictions = 0

  constructor(seed: LoroDoc) {
    this.stored = seed.export({ mode: 'snapshot' })
  }

  get(): LoroDoc {
    this.cached ??= LoroDoc.fromSnapshot(this.stored)
    return this.cached
  }

  save(doc: LoroDoc): void {
    this.saves += 1
    this.stored = doc.export({ mode: 'snapshot' })
  }

  evict(): void {
    this.evictions += 1
    this.cached = null
  }
}
