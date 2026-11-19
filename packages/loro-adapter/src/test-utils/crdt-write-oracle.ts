/**
 * The writes a recorded CRDT write row replays: the engine's own writers, and
 * `minimalChange`, a pure helper the oracle records for the helper's own
 * parity but which is no document write, so the engine contract does not name
 * it and its `write` refuses it.
 */

import type { LoroDoc } from 'loro-crdt'
import { applyWriter, WRITERS } from '../engine/writers.js'
import { minimalChange } from '../minimal-change.js'

/** The clock every recorded write ran under; a replay pins `Date.now` to it. */
export const RECORDED_NOW = 1_700_000_000_000

export const ORACLE_WRITERS = {
  ...WRITERS,
  minimalChange: (args: { current: string; next: string }) =>
    minimalChange(args.current, args.next),
}

export function applyOracleWriter(doc: LoroDoc, op: string, args: unknown): unknown {
  if (op === 'minimalChange')
    return ORACLE_WRITERS.minimalChange(args as { current: string; next: string })
  return applyWriter(doc, op, args)
}
