import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { parseSpatial } from '../../spatial/parse.js'
import { serializeSpatial } from '../../spatial/serialize.js'
import {
  decode as decodeBits,
  type Encoded,
  encode as encodeBits,
} from '../frontmatter-oracle/oracle.js'

/**
 * The TypeScript's answers that the Rust JSON Canvas codec is held to
 * (`crates/core/codec/tests/json_canvas_oracle.rs`).
 *
 * A reader outcome is the document, encoded as the frontmatter oracle encodes a
 * value (a number is the hex of its 64 bits) with every object's keys in the
 * model schema's order, or a refusal: the stage and, for a schema failure, each
 * Zod issue's path and code. Message text is not recorded; Rust words its
 * refusals in its own types. A writer outcome is the text, or the issues of the
 * wire schema the strict mode re-validates against.
 */
/**
 * The frontmatter oracle's encoding, but for a number that is a safe integer
 * other than `-0`, which is itself: a canvas holds hundreds of them and the
 * 16 hex digits of each were most of the recording. Anything else keeps its bits.
 */
type Compact = Encoded | number

function encode(value: unknown): Compact {
  if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0))
    return value
  if (Array.isArray(value)) return value.map(encode) as Compact
  if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    const record = value as Record<string, unknown>
    return { m: Object.keys(record).map((key) => [key, encode(record[key])]) } as Compact
  }
  return encodeBits(value)
}

function decode(encoded: Compact): unknown {
  if (typeof encoded === 'number') return encoded
  if (Array.isArray(encoded)) return encoded.map(decode)
  if (encoded !== null && typeof encoded === 'object' && 'm' in encoded) {
    return Object.fromEntries(encoded.m.map(([key, item]) => [key, decode(item as Compact)]))
  }
  return decodeBits(encoded)
}

export type Issues = [(string | number)[], string][]

type Refusal =
  | { stage: 'json-syntax' }
  | { stage: 'json-canvas-schema'; class: 'conversation' }
  | { stage: 'json-canvas-schema'; class: 'schema'; issues: Issues }

export type ReaderCase = { k: 'r'; t: string } & ({ ok: Compact } | { err: Refusal })
export type WriterCase = { k: 'w'; m: SpatialSerializeMode; c: Compact } & (
  | { y: string }
  | { err: { issues: Issues } }
)
export type RecordedCase = ReaderCase | WriterCase

/** How a canvas is written: the second argument of `serializeSpatial`. */
type SpatialSerializeMode = Parameters<typeof serializeSpatial>[1]

type Obj = Record<string, unknown>

/** The keys of `source` named in `keys`, in that order, leaving out an absent one. */
function inOrder(source: Obj, keys: readonly string[], values: Obj = {}): Obj {
  const out: Obj = {}
  for (const key of keys) {
    const value = key in values ? values[key] : source[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

const each = <T>(items: unknown, map: (item: T) => unknown): unknown =>
  Array.isArray(items) ? items.map((item) => map(item as T)) : items

const point = (p: Obj): Obj => inOrder(p, ['x', 'y'])
const edgeEnd = (e: Obj): Obj => inOrder(e, ['node', 'side', 'end'])
const lineEnd = (e: Obj): Obj =>
  e.kind === 'point'
    ? inOrder(e, ['kind', 'point', 'end'], { point: point(e.point as Obj) })
    : inOrder(e, ['kind', 'node', 'side', 'end'])

/**
 * A canvas with every object's keys in the order the Rust types hold them,
 * which is the contract's field order. A JavaScript object's own order is
 * whatever the producer wrote, and a Rust struct has none, so the recording
 * fixes one for both sides.
 */
function inSchemaOrder(canvas: SpatialCanvas): Obj {
  const c = canvas as unknown as Obj
  const node = (n: Obj): Obj =>
    inOrder(
      n,
      [
        'id',
        'x',
        'y',
        'width',
        'height',
        'color',
        'embed',
        'facets',
        'tags',
        'resource',
        'label',
        'background',
        'backgroundStyle',
      ],
      {
        embed: n.embed && inOrder(n.embed as Obj, ['documentId', 'versionRef']),
        resource:
          n.resource && inOrder(n.resource as Obj, ['mimeType', 'content', 'location', 'subpath']),
      },
    )
  const edge = (e: Obj): Obj =>
    inOrder(e, ['id', 'from', 'to', 'color', 'label', 'bends', 'facets', 'tags'], {
      from: edgeEnd(e.from as Obj),
      to: edgeEnd(e.to as Obj),
      bends: each(e.bends, point),
    })
  const line = (l: Obj): Obj =>
    inOrder(l, ['id', 'from', 'to', 'color', 'label', 'bends', 'facets'], {
      from: lineEnd(l.from as Obj),
      to: lineEnd(l.to as Obj),
      bends: each(l.bends, point),
    })
  return inOrder(c, ['nodes', 'edges', 'lines', 'facets', 'tags'], {
    nodes: each(c.nodes, node),
    edges: each(c.edges, edge),
    lines: each(c.lines, line),
  })
}

const issuesOf = (issues: readonly { path: PropertyKey[]; code: string }[]): Issues =>
  issues.map((issue) => [
    issue.path.map((step) => (typeof step === 'number' ? step : String(step))),
    issue.code,
  ])

export function readerCase(t: string): ReaderCase {
  const result = parseSpatial(t)
  if (result.ok) return { k: 'r', t, ok: encode(inSchemaOrder(result.value)) }
  const { stage, message, issues } = result.error
  if (stage === 'json-syntax') return { k: 'r', t, err: { stage } }
  if (issues.length > 0) {
    return {
      k: 'r',
      t,
      err: { stage: 'json-canvas-schema', class: 'schema', issues: issuesOf(issues) },
    }
  }
  if (!message.startsWith('this file carries x-whiteboard.comments')) {
    throw new Error(`a refusal the oracle has no class for: ${message}`)
  }
  return { k: 'r', t, err: { stage: 'json-canvas-schema', class: 'conversation' } }
}

/** A canvas as the writer is asked about it: `encoded` is what the recording holds. */
export function writerCase(canvas: SpatialCanvas, m: SpatialSerializeMode): WriterCase {
  const c = encode(inSchemaOrder(canvas))
  return answerWriter(c, m)
}

function answerWriter(c: Compact, m: SpatialSerializeMode): WriterCase {
  const canvas = decode(c) as SpatialCanvas
  try {
    return { k: 'w', m, c, y: serializeSpatial(canvas, m) }
  } catch (error) {
    const issues = (error as { issues?: { path: PropertyKey[]; code: string }[] }).issues
    if (issues === undefined) throw error
    return { k: 'w', m, c, err: { issues: issuesOf(issues) } }
  }
}

export function encodeRecording(cases: readonly RecordedCase[]): string {
  return `${cases.map((c) => JSON.stringify(c)).join('\n')}\n`
}

export function decodeRecording(text: string): RecordedCase[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as RecordedCase)
}

/** What the TypeScript answers today for a recorded case's input. */
export function answerAgain(recorded: RecordedCase): RecordedCase {
  return recorded.k === 'r' ? readerCase(recorded.t) : answerWriter(recorded.c, recorded.m)
}
