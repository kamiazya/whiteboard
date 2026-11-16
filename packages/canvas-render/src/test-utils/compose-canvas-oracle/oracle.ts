import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'
import type { Scene, SceneNode } from '@kamiazya/whiteboard-scene'

/** Parts of a record this file no longer spells out: the recording holds them as JSON. */
type CanvasWire = unknown
type CaseSpec = unknown
type TagLibrary = unknown

/**
 * The shape of a frozen recording (ADR-0054 step 7, S18h): what the TypeScript answered before it was deleted. The Rust port replays the recording natively; nothing here answers it again.
 */
interface MetaRecord {
  readonly kind: 'meta'
  readonly themes: unknown
  readonly library: TagLibrary
  /** Each body as parsed with its references resolved. */
  readonly bodies: Readonly<Record<string, MdastRoot>>
  /** The canvas each reference resolves to, as the replay reads a canvas. */
  readonly references: Readonly<Record<string, CanvasWire>>
  /** The document a body's `![[child]]` names: its title and canvas. */
  readonly embeds: Readonly<Record<string, { title: string; canvas: CanvasWire }>>
}

interface Event {
  readonly kind: string
  readonly nodeId: string
  readonly detail: string
}

interface CanvasAnswer {
  readonly scene: string
  /** What the overlays drew: everything after the first `from` nodes. */
  readonly overlay: { readonly from: number; readonly nodes: readonly SceneNode[] }
  readonly legend: Scene['legend'] | null
  readonly anchors: readonly (readonly (string | null)[])[]
  readonly events: readonly Event[]
  /** What the walk asked the measurer, the overlays' own questions not counted. */
  readonly calls: number
  /** The keys the content cache was asked, when the case hands one over. */
  readonly asked?: readonly string[]
}

interface EntryAnswer {
  readonly scene: string
  readonly events: readonly Event[]
  readonly calls: number
}

interface CaseRecord extends Omit<CaseSpec, 'geometry' | 'overrides'> {
  readonly kind: 'case'
  readonly id: string
  readonly canvas: CanvasWire
  readonly geometry?: readonly string[]
  readonly overrides?: unknown
  readonly answer: {
    readonly canvas: CanvasAnswer
    readonly edges: EntryAnswer
    /** Each node's natural size, `[id, w, h]`, then the measurer calls over them all. */
    readonly natural: readonly (readonly string[])[]
    readonly naturalCalls: number
    readonly naturalEvents: readonly Event[]
    readonly naturalAsked?: readonly string[]
  }
}

export type ComposeCanvasRecord = MetaRecord | CaseRecord
