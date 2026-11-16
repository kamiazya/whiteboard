/**
 * The shape of a frozen recording (ADR-0054 step 7, S18h): what the
 * TypeScript line jumps' broad phase (its run placement and segment grid)
 * answered before it was deleted, driven as the jumps drove it. Recorded per
 * run: where it was placed (its level and bounds) or `null`; the levels it
 * reaches, each with its cells; its candidates as inclusive ranges of filing
 * indices, or `"spent"`; and the work the grid had counted after each step.
 * Every double is the hex of its IEEE bits, a NaN the canonical one. The Rust
 * port replays the recording natively; nothing here answers it again.
 */
type ReachWire = readonly (readonly [number, 0 | 1, readonly string[]])[]

/** One edge's step: each run's reach, then each run's candidates. */
interface EdgeStep {
  readonly reached: readonly (ReachWire | null)[]
  readonly workAfterReach: number
  readonly candidates: readonly (readonly (readonly [number, number])[] | 'spent' | null)[]
  readonly workAfter: number
}

export interface EdgeJumpGridRecord {
  readonly id: string
  readonly edges: readonly (readonly (readonly string[])[])[]
  readonly placed: readonly (readonly (readonly [number, ...string[]] | null)[])[]
  readonly steps: readonly EdgeStep[]
}
