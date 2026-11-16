/**
 * The recorded answers of `outlineContentBox` (ADR-0054 step 7, S18a), the
 * box the editor's markdown overlay is placed in over a shaped node: every
 * bundled silhouette, no silhouette and an unknown one, over boxes square,
 * wide, tall, fractional, degenerate and not finite, at the origin and far
 * from it. Every double is the hex of its bits.
 */

export interface OutlineContentBoxRecord {
  readonly shape: string | null
  readonly box: readonly string[]
  readonly answer: readonly string[]
}
