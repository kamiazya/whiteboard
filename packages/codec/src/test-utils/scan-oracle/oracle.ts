import { findNextReference, scanReferences } from '../../references/scan.js'
import { toWellFormed } from '../frontmatter-oracle/oracle.js'
import { type Input, inputs, RANDOM_COUNT, SEED } from './corpus.js'

/**
 * The answers recorded from `scanReferences` that `whiteboard-codec`'s
 * `find_next_reference` is held to (`crates/core/codec/tests/scan_oracle.rs`).
 * `r` is every match as `[index, full, isEmbed, target, alias, fragment]`
 * with `null` for an absent alias or fragment; the index counts UTF-16 units,
 * as the TypeScript does, and the replay converts the Rust port's byte offsets.
 * `n`, kept for the short inputs, is where the first match at or after each
 * cursor starts (`-1` for none), so the scan's resume rules are held from any
 * start and not only from 0.
 */
type Row = readonly [number, string, boolean, string, string | null, string | null]
export type Case = Input & { r: readonly Row[]; n?: readonly number[] }
export type Meta = { kind: 'meta'; seed: number; random: number }

const CURSOR_PROBE_MAX = 40

function answer(input: Input): Case {
  const t = toWellFormed(input.t)
  const r = scanReferences(t).map(
    (m): Row => [m.index, m.full, m.isEmbed, m.target, m.alias ?? null, m.fragment ?? null],
  )
  if (t.length > CURSOR_PROBE_MAX) return { i: input.i, t, r }
  const n = Array.from({ length: t.length + 1 }, (_, cursor) => nextFrom(t, cursor))
  return { i: input.i, t, r, n }
}

const nextFrom = (t: string, cursor: number): number => findNextReference(t, cursor)?.index ?? -1

export const record = (): (Meta | Case)[] => [
  { kind: 'meta', seed: SEED, random: RANDOM_COUNT },
  ...inputs().map(answer),
]
