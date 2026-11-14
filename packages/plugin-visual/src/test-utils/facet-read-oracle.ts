/**
 * The plugin's facet readers, recorded for the Rust readers to replay
 * (`crates/core/plugin-visual/tests/facet_read_oracle.rs`): each reader asked of
 * a bucket holding its key with every payload the write recording holds for
 * that key — accepted, refused and hand-written alike — and of the buckets
 * that hold no payload for it at all.
 *
 * The payloads come from `facet-write.jsonl`, whose draws already reach every
 * stage of a facet's schema, so this recording adds no generator of its own.
 */
import { decode, type Encoded, encode } from '@kamiazya/whiteboard-model/test-utils'
import { resolveNodeStencil } from '../apply-stencil.js'
import {
  resolveCanvasEdgeStyle,
  resolveCanvasTheme,
  resolveEdgeOwnStyle,
  resolveNodeShape,
  resolveNodeSymbol,
  resolveNodeTextAlign,
  resolveStrokeWidth,
} from '../data.js'

type Bucket = Readonly<Record<string, unknown>> | undefined

/** What a reader answers for a bucket, as JSON. */
const READERS = {
  shape: ['visual.shape/v0', (facets: Bucket) => node(facets, resolveNodeShape)],
  text: ['visual.text/v0', (facets: Bucket) => node(facets, resolveNodeTextAlign)],
  edges: ['visual.edges/v0', (facets: Bucket) => resolveEdgeOwnStyle(edge(facets))],
  'canvas-edges': ['visual.edges/v0', (facets: Bucket) => resolveCanvasEdgeStyle(board(facets))],
  stroke: ['visual.stroke/v0', (facets: Bucket) => resolveStrokeWidth(edge(facets))],
  theme: ['visual.theme/v0', (facets: Bucket) => resolveCanvasTheme(board(facets))],
  stencil: ['visual.stencil/v0', (facets: Bucket) => node(facets, resolveNodeStencil)],
  symbol: ['visual.symbol/v0', (facets: Bucket) => node(facets, resolveNodeSymbol)],
} as const

type ReaderName = keyof typeof READERS

const withFacets = (facets: Bucket) => (facets === undefined ? {} : { facets })

function node<T>(facets: Bucket, read: (node: never) => T): T {
  return read({ id: 'n', x: 0, y: 0, width: 1, height: 1, ...withFacets(facets) } as never)
}

const edge = (facets: Bucket) =>
  ({ id: 'e', from: { node: 'a' }, to: { node: 'b' }, ...withFacets(facets) }) as never

const board = (facets: Bucket) => ({ nodes: [], edges: [], ...withFacets(facets) }) as never

export interface ReadLine {
  readonly reader: ReaderName
  /** The bucket, absent for an object with none. */
  readonly in: Encoded | null
  readonly out: unknown
}

const answer = (reader: ReaderName, bucket: Bucket): unknown => READERS[reader][1](bucket) ?? null

function lineOf(reader: ReaderName, bucket: Bucket): ReadLine {
  return { reader, in: bucket === undefined ? null : encode(bucket), out: answer(reader, bucket) }
}

/** The buckets that hold nothing a reader reads. */
function emptyBuckets(key: string): Bucket[] {
  const next = key.replace('/v0', '/v1')
  return [undefined, {}, { [next]: {} }, { 'other.facet/v0': { kind: 'ellipse' } }]
}

/** Every line, from the write recording's `(key, payload)` pairs. */
export function recordReadLines(writes: readonly (readonly [string, Encoded])[]): ReadLine[] {
  return (Object.keys(READERS) as ReaderName[]).flatMap((reader) => {
    const key = READERS[reader][0]
    const stored = writes.filter(([written]) => written === key).map(([, payload]) => payload)
    const buckets: Bucket[] = [
      ...emptyBuckets(key),
      ...stored.map((payload) => ({ 'other.facet/v0': 1, [key]: decode(payload) })),
    ]
    return buckets.map((bucket) => lineOf(reader, bucket))
  })
}

/** A recorded line answered again from its inputs. */
export function answerReadAgain(line: ReadLine): ReadLine {
  const bucket = line.in === null ? undefined : (decode(line.in) as Bucket)
  return lineOf(line.reader, bucket)
}
