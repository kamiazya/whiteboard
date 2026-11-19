/**
 * What the recorder (`scripts/record-crdt-mechanics-oracle.ts`) and the replay
 * (`oracle/crdt-mechanics-recorded-oracle.test.ts`) both use to turn loro-crdt
 * values into plain JSON and back. A refusal is recorded as its class, because
 * the Rust replay has to refuse the same inputs and a message is the one thing
 * a port words differently.
 */
import {
  decodeFrontiers,
  encodeFrontiers,
  type Frontiers,
  type LoroDoc,
  VersionVector as LoroVersionVector,
  type PeerID,
} from 'loro-crdt'
import { compactionCut, frontiersFromBase64, frontiersToBase64 } from '../index.js'

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

/**
 * The judgements as they were recorded — over a document and its frontiers —
 * adapted onto the plain-value API: the document is what turns frontiers into
 * version vectors and back, so the adapter is where loro-crdt stays.
 */
export function compactionCutOverDoc(doc: LoroDoc, points: readonly Frontiers[]): Frontiers | null {
  let vectors: Array<Map<string, number>>
  try {
    vectors = points.map((point) => new Map<string, number>(doc.frontiersToVV(point).toJSON()))
  } catch {
    return null
  }
  const root = new Map<string, number>(doc.frontiersToVV(doc.shallowSinceFrontiers()).toJSON())
  const cut = compactionCut(vectors, root)
  return cut === null
    ? null
    : doc.vvToFrontiers(LoroVersionVector.parseJSON(cut as Map<PeerID, number>))
}

export function frontiersToBase64OfFrontiers(frontiers: Frontiers): string {
  return frontiersToBase64(encodeFrontiers(frontiers))
}

export function frontiersFromBase64ToFrontiers(text: string): Frontiers {
  return decodeFrontiers(frontiersFromBase64(text))
}
