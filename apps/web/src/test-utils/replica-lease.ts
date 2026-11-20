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
import { vi } from 'vitest'

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

/** Lends the record's lease to `fn` and releases it afterwards, so a test's own input never outlives its call. */
export async function withLeaseOf<T>(
  doc: LoroDoc,
  fn: (held: RecordLease) => T | Promise<T>,
): Promise<T> {
  return lease.withLease(await leaseOf(doc), fn)
}

/**
 * Records the handles the engine mints (`open` and `fork`) and every handle
 * given to `close`, so a test can assert each handle IT saw minted was closed
 * exactly once, which an opened-versus-closed count cannot: closing one handle
 * twice hides another's leak. Spies are removed by `vi.restoreAllMocks()`.
 */
export async function watchEngineHandles() {
  const engine = await loadCrdtEngine()
  const open = vi.spyOn(engine, 'open')
  const fork = vi.spyOn(engine, 'fork')
  const close = vi.spyOn(engine, 'close')
  const returned = (spy: { mock: { results: Array<{ type: string; value: unknown }> } }) =>
    spy.mock.results.flatMap((result) =>
      result.type === 'return' ? [(result.value as { handle: number }).handle] : [],
    )
  return {
    minted: () => [...returned(open), ...returned(fork)],
    forked: () => returned(fork),
    /** The minted handles that were not closed exactly once; empty when nothing leaked or double-closed. */
    unaccounted: () => {
      const closed = close.mock.calls.map(([request]) => request.handle)
      return [...returned(open), ...returned(fork)].filter(
        (handle) => closed.filter((c) => c === handle).length !== 1,
      )
    },
  }
}
