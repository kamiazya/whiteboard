type TextQuoteSelector = unknown

/**
 * The shape of a frozen recording (ADR-0054 step 7, S18h): what the TypeScript answered before it was deleted. The Rust port replays the recording natively; nothing here answers it again.
 */
type Measured = 'fake' | 'odd'

interface RunWire {
  readonly text: string
  readonly bbox: readonly string[]
  readonly emphasis: boolean
  readonly strong: boolean
  /** The family and size the run's paint carries, null when it has no paint. */
  readonly paint: { readonly family?: string; readonly size?: string } | null
  /** What enclosing list items and table cells shift it by, when anything. */
  readonly offsetX?: string
}

interface PassageWire {
  readonly threadId: string
  readonly quote: TextQuoteSelector
  readonly start: number
  readonly end: number
  readonly resolved: boolean
}

export type PassageHighlightRecord =
  | {
      readonly kind: 'occurrences'
      readonly haystack: string
      readonly needle: string
      readonly answer: readonly number[]
    }
  | {
      readonly kind: 'scored'
      readonly sorted: readonly number[]
      readonly around: number
      readonly max: number
      readonly answer: readonly [number, number]
    }
  | {
      readonly kind: 'resolve'
      readonly body: string
      readonly quote: TextQuoteSelector
      readonly start: number
      readonly end: number
      readonly answer: readonly [number, number] | null
    }
  | {
      readonly kind: 'loose'
      readonly text: string
      readonly quote: string
      readonly answer: readonly (readonly [number, number])[]
    }
  | {
      readonly kind: 'highlights'
      readonly runs: readonly RunWire[]
      readonly passages: readonly PassageWire[]
      readonly source: string
      readonly measure: Measured
      readonly answer: {
        /** Id, box, and which paint it took. */
        readonly shapes: readonly (readonly [string, readonly string[], string | null])[]
        /** What was measured: text, family, size, weight and slant. */
        readonly calls: readonly (readonly [string, string, string, number, string])[]
      }
    }
