import type { MdastRoot } from '@kamiazya/whiteboard-model/mdast'

/** Parts of a record this file no longer spells out: the recording holds them as JSON. */
type CanvasSummary = unknown
type EmbeddedWire = unknown
type MiniatureMode = unknown

/**
 * The shape of a frozen recording (ADR-0054 step 7, S18h): what the TypeScript answered before it was deleted. The Rust port replays the recording natively; nothing here answers it again.
 */
type ThemeName = 'node' | 'document' | 'compact'

/** What the host answered for the questions this input can ask. */
interface SeamTables {
  /** An icon range is in UTF-16 units, as the host's answer is. */
  readonly icons: Readonly<Record<string, readonly { from: number; to: number; name: string }[]>>
  readonly emoji: Readonly<Record<string, string>>
  readonly titles: Readonly<Record<string, string | null>>
  readonly embeds: Readonly<Record<string, string | null>>
  readonly pending: readonly string[]
  readonly images: Readonly<
    Record<string, { href: string; width?: number; height?: number } | null>
  >
  /** Token lines per `lang NUL source`; null where the seam threw or answered nothing. */
  readonly highlight: Readonly<Record<string, TokenLinesWire | null>>
  /** The math renderer's answer per source; null where it threw or answered nothing. */
  readonly math: Readonly<Record<string, RenderedWire | null>>
  /** The diagram renderer's answer per `lang NUL source`. */
  readonly diagram: Readonly<Record<string, RenderedWire | null>>
  /** What resolving each embed target answers; empty where the seam is absent. */
  readonly embedded: Readonly<Record<string, EmbeddedWire | null>>
  /** What a fragment keeps of a canvas target, per `id NUL fragment`. */
  readonly canvases: Readonly<Record<string, CanvasSummary>>
  /** How the host draws each canvas target's miniature. */
  readonly miniatures: Readonly<Record<string, MiniatureMode>>
}

/** Which embed seams the host supplies: none, the documents', or those and the canvas picture. */
type EmbedSeams = 'none' | 'documents' | 'full'

type TokenLinesWire = readonly (readonly { text: string; role?: string }[])[]

/** `s` is the string form a renderer may answer; the other is the object form. */
type RenderedWire = { s: string } | { svg: string; width?: number; height?: number }

interface TypesetInput {
  readonly id: string
  readonly root: MdastRoot
  /** The wrap width's IEEE bits, since JSON cannot hold NaN or infinity. */
  readonly width: string
  readonly theme: ThemeName
  readonly fill: string | null
  readonly embeds: EmbedSeams
  /** The fill of each token role, when the caller supplies a palette. */
  readonly syntax: Readonly<Record<string, string>> | null
  /** Hold the answer as a digest rather than as text. */
  readonly digest: boolean
  /** The documents the host is already laying out around this body; absent, none. */
  readonly embedPath?: readonly string[]
}

export type TypesetRecord = TypesetInput & {
  readonly seams: SeamTables
  readonly calls: number
} & ({ readonly scene: string } | { readonly n: number; readonly h: number })

export interface RecordMeta {
  readonly kind: 'meta'
  readonly seed: number
  readonly generated: number
}
