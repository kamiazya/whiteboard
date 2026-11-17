import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'

/** Parts of a record this file no longer spells out: the recording holds them as JSON. */
type CanvasWire = unknown
type CaseSpec = unknown
type ProposalWire = unknown

/** A degradation the layer reported. */
interface Event {
  readonly kind: string
  readonly nodeId?: string
}

/**
 * The shape of a frozen recording (ADR-0054 step 7, S18h): what the TypeScript answered before it was deleted. The Rust port replays the recording natively; nothing here answers it again.
 */
interface MetaRecord {
  readonly kind: 'meta'
  readonly themes: unknown
  readonly library: Record<string, never>
  readonly bodies: unknown
  /** Each message's markdown, as the comment layer's parser answers it. */
  readonly markdown: Readonly<Record<string, MdastRoot | null>>
  readonly references: Record<string, never>
  readonly embeds: Record<string, never>
}

type AnchorWire =
  | {
      readonly kind: 'spatial'
      readonly nodeId?: string
      readonly edgeId?: string
      readonly nodeIds?: readonly string[]
      readonly x: string
      readonly y: string
      readonly width?: string
      readonly height?: string
    }
  | {
      readonly kind: 'text'
      readonly nodeId?: string
      readonly quote: { readonly prefix?: string; readonly exact: string; readonly suffix?: string }
      readonly start: number
      readonly end: number
    }
  | { readonly kind: 'document' }

interface ThreadWire {
  readonly id: string
  readonly anchor: AnchorWire
  readonly resolved: boolean
  readonly messages: readonly { readonly id: string; readonly body: string }[]
}

interface CaseRecord extends Omit<CaseSpec, 'obstacles'> {
  readonly kind: 'case'
  readonly id: string
  readonly canvas: CanvasWire
  readonly threads: readonly ThreadWire[]
  readonly proposals?: readonly ProposalWire[]
  readonly obstacles?: readonly (readonly string[])[]
  readonly answer: {
    readonly scene: string
    /** Every question the layout asked the measurer: text, family and size. */
    readonly calls: readonly (readonly [string, string, string])[]
    readonly events: readonly Event[]
  }
}

export type ComposeCommentsRecord = MetaRecord | CaseRecord
