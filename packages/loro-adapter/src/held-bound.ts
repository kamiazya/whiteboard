// A measure of a record held as a bound between walks, for the judge that
// answers a short update without applying it (`syncTextLimitJudge`).
import type { LoroDoc, VersionVector } from 'loro-crdt'

/**
 * At least what `measure` answers of `record` now, without walking it on
 * every call: a walk is held as a bound and raised by the byte length of
 * whatever `record` gained since, since no gain adds more characters or map
 * entries than it has bytes. `walk` asks for a fresh reading, taken only when
 * the held one was raised rather than read.
 */
export function heldBound(
  record: LoroDoc,
  measure: (doc: LoroDoc) => number,
): (walk: boolean) => number {
  let held: { readonly at: VersionVector; readonly value: number; readonly read: boolean } | null =
    null
  return (walk) => {
    const at = record.oplogVersion()
    const current = held !== null && at.compare(held.at) === 0
    if (held !== null && current && (held.read || !walk)) return held.value
    held =
      held === null || walk
        ? { at, value: measure(record), read: true }
        : {
            at,
            value: held.value + record.export({ mode: 'update', from: held.at }).byteLength,
            read: false,
          }
    return held.value
  }
}
