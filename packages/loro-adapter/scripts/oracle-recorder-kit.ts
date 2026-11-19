/**
 * What the CRDT oracle recorders share: a pinned clock, a seeded generator and
 * the small value generators both draw their documents from. Importing it pins
 * `Date.now`, which is what makes a recording repeatable.
 */
import { fc } from '@kamiazya/whiteboard-model/test-utils'
import type { LoroDoc } from 'loro-crdt'

export const NOW = 1_700_000_000_000
Date.now = () => NOW

export function rngOf(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const ulid = (n: number): string =>
  `01ARZ3NDEKTSV4RRFFQ69G5F${CROCKFORD[(n >> 5) & 31]}${CROCKFORD[n & 31]}`.slice(0, 26)

export const WORDS = ['plan', 'draft', 'report', 'Friday', 'review', 'ship', 'weekly', 'notes', 'idea']
export const WIDE = ['😀', '👩‍👩‍👧', '𝒳', '日本語', 'é', 'é', '🇯🇵', '\u{10FFFF}', '\u0000']

export type Rng = () => number
export const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T
export const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))
export const sentence = (rng: Rng, n = int(rng, 3, 12)) =>
  Array.from({ length: n }, () => pick(rng, WORDS)).join(' ')
export const body = (rng: Rng, wide = false) =>
  Array.from({ length: int(rng, 1, 4) }, (_, i) => {
    const text = sentence(rng)
    const spice = wide ? ` ${pick(rng, WIDE)}${pick(rng, WIDE)} ` : ''
    return i === 0 ? `# ${text}${spice}` : `${text}${spice}`
  }).join('\n\n')

/**
 * Schema-derived payloads run to tens of kilobytes; the smallest of a wider draw
 * keeps the recording a size a repository carries, and still varies by seed.
 */
export function sample<T>(arb: fc.Arbitrary<T>, rng: Rng, n: number): T[] {
  const drawn = fc.sample(arb, { seed: Math.floor(rng() * 2 ** 31), numRuns: n * 5 })
  // An empty bucket is the smallest of all and would starve the shapes that need content.
  return drawn
    .map((value) => ({ value, size: JSON.stringify(value).length }))
    .map((entry) => (entry.size <= 2 ? { ...entry, size: 10 ** 9 } : entry))
    .sort((a, b) => a.size - b.size)
    .slice(0, n)
    .map(({ value }) => value)
}

/** A writer a generated payload may legitimately refuse: the row still records what landed. */
export function attempt(write: () => void): void {
  try {
    write()
  } catch {
    // a refusal is a shape the writers do not store
  }
}

export const peer = (doc: LoroDoc, id: number): LoroDoc => {
  doc.setPeerId(BigInt(id))
  return doc
}

