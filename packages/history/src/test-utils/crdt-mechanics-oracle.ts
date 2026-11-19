/**
 * What the recorder (`scripts/record-crdt-mechanics-oracle.ts`) and the replay
 * (`oracle/crdt-mechanics-recorded-oracle.test.ts`) both use to turn loro-crdt
 * values into plain JSON and back. A refusal is recorded as its class, because
 * the Rust replay has to refuse the same inputs and a message is the one thing
 * a port words differently.
 */
import type { Frontiers, PeerID } from 'loro-crdt'

/** `[peer, counter]` pairs, peers as decimal strings: JSON has no bigint. */
export type FrontierPairs = Array<[string, number]>

export type Answer = { ok: unknown } | { err: string }

export function pairsOfFrontiers(frontiers: Frontiers): FrontierPairs {
  return frontiers.map(({ peer, counter }) => [String(peer), counter] as [string, number])
}

export function frontiersOfPairs(pairs: FrontierPairs): Frontiers {
  return pairs.map(([peer, counter]) => ({ peer: peer as PeerID, counter }))
}

export function answer(read: () => unknown): Answer {
  try {
    return { ok: read() }
  } catch (error) {
    return { err: error instanceof Error ? error.constructor.name : typeof error }
  }
}
