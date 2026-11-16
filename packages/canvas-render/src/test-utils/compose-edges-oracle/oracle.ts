/** Parts of a record this file no longer spells out: the recording holds them as JSON. */
type Facts = unknown
type ThemeName = unknown

/**
 * The shape of a frozen recording (ADR-0054 step 7, S18h): what the TypeScript answered before it was deleted. The Rust port replays the recording natively; nothing here answers it again.
 */
interface MetaRecord {
  readonly kind: 'meta'
  readonly sketch: unknown
  readonly neon: unknown
}

interface CaseRecord {
  readonly kind: 'case'
  readonly id: string
  readonly theme: ThemeName
  readonly geometry: readonly string[]
  readonly facts: Facts
  readonly answer: Answer
}

interface Answer {
  readonly scene: string
  /** The anchors, in the order the routing settled them; every number as its hex. */
  readonly anchors: readonly (readonly (string | null)[])[]
  /** What `computeEdgeJumps` answers for the routed edges, when any element hops. */
  readonly jumps: readonly (readonly [string, readonly (readonly string[])[]])[] | null
  readonly calls: number
}

export type ComposeEdgesRecord = MetaRecord | CaseRecord
