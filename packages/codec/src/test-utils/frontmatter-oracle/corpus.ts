import { AWKWARD, FRAGMENTS, KEY_POOL, NUMBER_POOL, WORDS_LONG } from './corpus-data.js'

/** Seeded dice and value pools the recorded oracles draw their inputs from. */

type Random = () => number

export function mulberry32(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Dice {
  constructor(private readonly random: Random) {}
  int(n: number): number {
    return Math.floor(this.random() * n)
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T
  }
  chance(p: number): boolean {
    return this.random() < p
  }
}

export function nastyString(d: Dice): string {
  const r = d.int(100)
  if (r < 30) return d.pick(AWKWARD)
  if (r < 70) return Array.from({ length: d.int(12) }, () => d.pick(FRAGMENTS)).join('')
  if (r < 85)
    return Array.from({ length: 10 + d.int(50) }, () => d.pick(WORDS_LONG)).join(d.pick([' ', '']))
  return Array.from({ length: d.int(30) }, () =>
    String.fromCodePoint(
      d.pick([0x20, 0x61, 0xe9, 0x1f600, 0x0a, 0x09, 0x85, 0x7f, 0x01, 0x2028, 0xa0, 0x3000]),
    ),
  ).join('')
}

export function writerValue(d: Dice, depth: number): unknown {
  const r = d.int(100)
  if (depth > 3 || r < 55) {
    const t = d.int(100)
    if (t < 12) return d.pick(NUMBER_POOL)
    if (t < 20) return d.pick([true, false, null])
    if (t < 25) return d.int(2000) - 1000
    return nastyString(d)
  }
  if (r < 78) return Array.from({ length: d.int(5) }, () => writerValue(d, depth + 1))
  const entries = Array.from({ length: d.int(5) }, (): [string, unknown] => [
    d.chance(0.5) ? d.pick(KEY_POOL) : nastyString(d),
    writerValue(d, depth + 1),
  ])
  return Object.fromEntries(entries.filter(([k]) => k !== '__proto__'))
}
