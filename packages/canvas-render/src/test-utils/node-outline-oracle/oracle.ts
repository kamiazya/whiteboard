/**
 * The shape of a frozen recording (ADR-0054 step 7, S18h): what the
 * TypeScript silhouette hit test and edge anchoring answered before they were
 * deleted, for every bundled silhouette, an id no table carries, and boxes
 * from the ordinary to the degenerate and the non-finite. The Rust port
 * replays the recording natively; nothing here answers it again.
 *
 * A `contains` record holds the points asked and one `0`/`1` per point. An
 * `entry` record holds approaches (`from`, `to`) and where each lands. Every
 * double is the hex of its IEEE bits, a NaN the canonical one.
 */
interface ContainsRecord {
  readonly kind: 'contains'
  readonly shape: string
  readonly box: readonly string[]
  readonly points: readonly (readonly string[])[]
  /** One `0` or `1` per point. */
  readonly inside: string
}

interface EntryRecord {
  readonly kind: 'entry'
  readonly shape: string
  readonly box: readonly string[]
  /** `from`, `to` and where the terminal lands, as four doubles each pair of two. */
  readonly approaches: readonly (readonly string[])[]
}

export type NodeOutlineRecord = ContainsRecord | EntryRecord
