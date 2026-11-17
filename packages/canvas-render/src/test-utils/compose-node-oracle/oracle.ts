import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'

/** Parts of a record this file no longer spells out: the recording holds them as JSON. */
type CaseSpec = { readonly theme: string; readonly align: string | null }
interface DecorationRecord {
  readonly kind: 'decoration'
  readonly stencil: unknown
  readonly scene: string
}
interface FitRecord {
  readonly kind: 'fit'
}

/**
 * The shape of a frozen recording (ADR-0054 step 7, S18h): what the TypeScript answered before it was deleted. The Rust port replays the recording natively; nothing here answers it again.
 */
interface MetaRecord {
  readonly kind: 'meta'
  readonly sketch: unknown
  /** Each body as parsed with its references resolved; `null` is a parse that throws. */
  readonly bodies: Readonly<Record<string, MdastRoot | null>>
  /** The document embed target answered, by document id. */
  readonly embedded: Readonly<Record<string, { title: string; root: MdastRoot }>>
  /** The canvas embed target answered, by document id. */
  readonly canvases: Readonly<Record<string, { title: string; canvas: SpatialCanvas }>>
  readonly references: unknown
  readonly seeded: unknown
}

/** A node as data: its box as IEEE bits, the rest as JSON. */
interface NodeWire {
  readonly id: string
  readonly box: readonly string[]
  readonly color?: string
  readonly resource?: SpatialNode['resource']
  readonly label?: string
  readonly background?: string
  readonly backgroundStyle?: string
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
  readonly embedDepth: number
  /**
   * Which of the case's switches are on: `locked`, `suppressed` (the editor owns
   * the body), `emptyFrame`, `cache` (a content cache is handed over), `spent`
   * (the nested-layout budget has no layout left) and `collapsed` (the expansion
   * policy keeps a file node's canvas closed).
   */
  readonly flags: readonly Flag[]
  /** The layouts and elements left in the budget, when not the default. */
  readonly budget?: readonly [number, number]
  /** The documents being laid out around the node, when there are any. */
  readonly embedPath?: readonly string[]
  readonly answer: CaseAnswer
}

interface CaseAnswer {
  readonly scene: string
  readonly events: readonly { kind: string; nodeId: string; detail: string }[]
  readonly asked: readonly string[]
  readonly kept: readonly string[]
  readonly again: { n: number; h: number }
  readonly seeded: { n: number; h: number } | null
  readonly calls: number
}

export type ComposeNodeRecord = MetaRecord | CaseRecord | DecorationRecord | FitRecord

type Flag = 'locked' | 'suppressed' | 'emptyFrame' | 'cache' | 'spent' | 'collapsed'
