import type { SceneNode } from '@kamiazya/whiteboard-scene'
import type { FenceHighlighter, FenceTokenMemo } from './fence-tokens.js'
import type { FontHandles } from './font-handles.js'
import { LAYOUT_QUERY_CAPS } from './generated/input-caps.js'
import type { HostMeasure } from './host-measure.js'
import {
  drawnRefusal,
  type LayoutErrors,
  type LayoutEvent,
  type LayoutGlue,
  type LayoutRefusal,
  type LayoutRequest,
  layoutWith,
  type Read,
} from './layout.js'
import { wireOf } from './value-wire.js'

// The layout pieces a root calls on their own, over the artifact's one query
// export (`crates/bindings/wasm/src/spatial_layout/query.rs`, ADR-0054 step 7,
// S18d). Typed structurally, as the whole layout's request is: canvas-render
// builds each query, and this package may not import it.

/** A box, `[x, y, w, h]`. */
type Box = readonly [number, number, number, number]
type Pair = readonly [number, number]

/**
 * A query the core measures: the edge layer of a canvas request (`edges`,
 * every field a canvas request carries), the spatial digest of the scene it
 * lays out (`scene-digest`), a node's fitted height (`node-size`) or its
 * content's natural size (`node-content`).
 */
type MeasuredQuery = LayoutRequest & {
  readonly query: 'edges' | 'scene-digest' | 'node-size' | 'node-content'
}

/** A query that measures nothing: placement geometry over boxes and points. */
type GeometryQuery =
  | {
      readonly query: 'label-placement'
      readonly path: readonly Pair[]
      readonly size: Pair
      readonly obstacles: readonly Box[]
      readonly rounded: boolean
    }
  | {
      readonly query: 'label-obstacles'
      readonly nodes: readonly object[]
      /** The scene's runs that annotate an element: what each annotates, and its box. */
      readonly runs: readonly (readonly ['node' | 'edge', string, Box])[]
    }
  | {
      readonly query: 'comment-bubble'
      readonly anchor: Pair
      readonly size: Pair
      readonly obstacles: readonly Box[]
    }
  | { readonly query: 'outline-content-box'; readonly shape?: string; readonly box: Box }

export type LayoutQueryRequest = MeasuredQuery | GeometryQuery

/** A number, or a list of them, as the core answers a geometry query. */
type QueryNumbers = number | readonly QueryNumbers[]

/**
 * The core's answer: an edge layer and what the layout reported beside it;
 * a scene digest, as the JSON text the core wrote, with what the layout reported;
 * the numbers of any other query, each double exactly as the core computed it
 * (a non-finite one included); or what it refused, which a query's caller
 * answers as the query says, having no scene to draw a refusal in.
 */
export type LayoutQueryAnswer =
  | { readonly nodes: readonly SceneNode[]; readonly degradations: readonly LayoutEvent[] }
  | { readonly digest: string; readonly degradations: readonly LayoutEvent[] }
  | { readonly numbers: readonly QueryNumbers[] }
  | { readonly refused: LayoutRefusal }

const OPERATION = 'layout_query'

const bits = new DataView(new ArrayBuffer(8))

/** A double from the sixteen hex digits of its bits, or a list of them; undefined when it is neither. */
function numbersOf(value: unknown): QueryNumbers | undefined {
  if (typeof value === 'string' && /^[0-9a-f]{16}$/.test(value)) {
    bits.setBigUint64(0, BigInt(`0x${value}`))
    return bits.getFloat64(0)
  }
  if (!Array.isArray(value)) return undefined
  const items = value.map(numbersOf)
  return items.includes(undefined) ? undefined : (items as QueryNumbers[])
}

/** What the core refused, as a root would draw it. */
function unanswered(parsed: unknown[]): { readonly refused: LayoutRefusal } | undefined {
  const refused = drawnRefusal(parsed)
  return refused === undefined ? undefined : { refused }
}

function refusedDetail([kind, , b]: unknown[]): string {
  return kind === 'refused' && typeof b === 'string' ? b : 'answer'
}

const readEdges: Read<LayoutQueryAnswer> = (parsed, errors) => {
  const refused = unanswered(parsed)
  if (refused !== undefined) return refused
  const [kind, nodes, events] = parsed
  if (kind === 'ok' && Array.isArray(nodes) && Array.isArray(events) && parsed.length === 3) {
    return { nodes: nodes as SceneNode[], degradations: events as LayoutEvent[] }
  }
  throw errors.refused(OPERATION, 'malformed', refusedDetail(parsed))
}

const readDigest: Read<LayoutQueryAnswer> = (parsed, errors) => {
  const refused = unanswered(parsed)
  if (refused !== undefined) return refused
  const [kind, digest, events] = parsed
  if (kind === 'ok' && typeof digest === 'string' && Array.isArray(events) && parsed.length === 3) {
    return { digest, degradations: events as LayoutEvent[] }
  }
  throw errors.refused(OPERATION, 'malformed', refusedDetail(parsed))
}

const readNumbers: Read<LayoutQueryAnswer> = (parsed, errors) => {
  const refused = unanswered(parsed)
  if (refused !== undefined) return refused
  const [kind, ...rest] = parsed
  const numbers = numbersOf(rest)
  if (kind === 'ok' && Array.isArray(numbers)) return { numbers }
  throw errors.refused(OPERATION, 'malformed', refusedDetail(parsed))
}

/** What a query call goes through, as a layout call does. */
export interface QueryCalls {
  readonly glue: LayoutGlue
  readonly errors: LayoutErrors
  readonly highlight: FenceHighlighter | undefined
  readonly memo: FenceTokenMemo
  readonly fonts: FontHandles
}

/**
 * A query answered by the core. A measured one goes through the whole
 * layout's calls (the faces' handle, the host's measurer, the fences the core
 * asks for and their tokens), so `edges`, `node-size` and `node-content` are
 * measured exactly as a layout of the same canvas is; a geometry query is one
 * call. Throws `CoreInputRefused` for a request the wire does not carry or an
 * answer that is not one.
 */
export function layoutQuery(
  calls: QueryCalls,
  request: LayoutQueryRequest,
  hostMeasure: HostMeasure | undefined,
): LayoutQueryAnswer {
  const { glue, errors } = calls
  if ('measure' in request) {
    const read =
      request.query === 'edges'
        ? readEdges
        : request.query === 'scene-digest'
          ? readDigest
          : readNumbers
    return layoutWith({ ...calls, entry: OPERATION }, request, read, hostMeasure, undefined)
  }
  const wire = wireOf(request, 0, true)
  if (wire === undefined) throw errors.refused(OPERATION, 'malformed', 'wire')
  const text = JSON.stringify(wire)
  if (text.length > LAYOUT_QUERY_CAPS.maxBytes) {
    return { refused: { code: 'input-too-large', reason: 'too-large' } }
  }
  const parsed: unknown = JSON.parse(glue.layout_query(text))
  return readNumbers(Array.isArray(parsed) ? parsed : [], errors)
}
