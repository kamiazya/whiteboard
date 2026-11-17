/**
 * The shape of a frozen recording (ADR-0054 step 7, S18h): what the
 * TypeScript line jumps answered before they were deleted — for each board,
 * every edge's id and path as handed in, and the hops it answered, by edge id
 * in the map's own order, each as its segment and point. Every double is the
 * hex of its IEEE bits, a NaN the canonical one. The Rust port replays the
 * recording natively; nothing here answers it again.
 */
export interface EdgeJumpsRecord {
  readonly id: string
  readonly edges: readonly (readonly [string, readonly (readonly [string, string])[]])[]
  readonly jumps: readonly (readonly [string, readonly (readonly [number, string, string])[]])[]
}
