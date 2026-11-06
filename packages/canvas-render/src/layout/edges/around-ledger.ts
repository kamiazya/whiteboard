/**
 * The side search's record of which stepping-round choices it has PRICED,
 * so a search the layout's routing account cuts short can tell a decision
 * from a seed (`spatial-edges.ts`'s `steppingRound` and `shortened`).
 */

import type { SidePair } from './edge-rules.js'

/**
 * Which `around` choices the search has priced. A straight edge is SEEDED
 * stepping round (`steppingRound`) on the expectation that `shortened`
 * prices its corner route before the search ends; a search the layout's
 * account cuts short never does, and a seeded detour nobody priced is
 * just a longer line. So on exhaustion every seeded `around` the search did
 * not confirm — by adopting it as a candidate, or by finding its corner
 * route costs more — goes back to the corner route, while what the search
 * DID confirm, and what it never seeded (a frozen override, or the aligned
 * run's input, which the first run already priced or dropped), stays.
 */
export interface AroundLedger {
  readonly confirmed: Set<string>
  /** Records a candidate the search adopted: stepping round, it is confirmed. */
  readonly adopted: (id: string, pair: SidePair) => void
  readonly unconfirmedDropped: (
    sides: ReadonlyMap<string, SidePair>,
  ) => ReadonlyMap<string, SidePair>
}

export function aroundLedger(seeded: ReadonlySet<string>): AroundLedger {
  const confirmed = new Set<string>()
  return {
    confirmed,
    adopted: (id, pair) => {
      if (pair.around === true) confirmed.add(id)
    },
    unconfirmedDropped: (sides) => {
      const dropped = new Map(sides)
      for (const [id, pair] of sides) {
        if (pair.around !== true || !seeded.has(id) || confirmed.has(id)) continue
        dropped.set(id, { fromSide: pair.fromSide, toSide: pair.toSide })
      }
      return dropped
    },
  }
}
