import type { SpatialNode } from '@kamiazya/whiteboard-model'
import type { SceneNode } from '@kamiazya/whiteboard-scene'

/** Parts of a record this file no longer spells out: the recording holds them as JSON. */
type CaseSpec = { readonly theme: string; readonly align: string | null }
type ResolvedWire = unknown

/**
 * The shape of a frozen recording (ADR-0054 step 7, S18h): what the TypeScript answered before it was deleted. The Rust port replays the recording natively; nothing here answers it again.
 */
interface MetaRecord {
  readonly kind: 'meta'
  /** The sketch theme's tokens, which the replay reads into its own types. */
  readonly sketch: unknown
  /** The content scenes a case places, by name, as plain JSON. */
  readonly contents: Readonly<Record<string, readonly SceneNode[]>>
}

interface SeedRecord {
  readonly kind: 'seed'
  readonly ids: readonly string[]
  readonly seeds: readonly number[]
}

interface TranslateRecord {
  readonly kind: 'translate'
  readonly content: string
  readonly dx: string
  readonly dy: string
  readonly n: number
  readonly h: number
}

/** A node as data: its box as IEEE bits, the rest as JSON. */
interface NodeWire {
  readonly id: string
  readonly box: readonly string[]
  readonly color?: string
  readonly resource?: SpatialNode['resource']
  readonly label?: string
}

interface CaseRecord {
  readonly kind: 'case'
  readonly id: string
  readonly node: NodeWire
  readonly theme: CaseSpec['theme']
  readonly fitToBox: boolean
  /** The alignment the node's `visual.text/v0` payload names, none for no payload. */
  readonly align: CaseSpec['align']
  readonly shape: string | null
  readonly geometry: readonly string[]
  readonly resolved: ResolvedWire
  readonly probe: string
  readonly content: string
  readonly answer: CaseAnswer
}

interface CaseAnswer {
  readonly bounds: readonly string[]
  readonly width: string
  readonly chrome: string
  readonly fitted: string
  readonly label: string | null
  readonly above: string
  readonly inside: string
  readonly probe: string
  readonly placed: { n: number; h: number }
  readonly lifted: { n: number; h: number }
  readonly fit: { n: number; h: number; truncated: boolean; overflows: boolean } | null
  readonly calls: number
}

export type NodeBoxRecord = MetaRecord | SeedRecord | TranslateRecord | CaseRecord
