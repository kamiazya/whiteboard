import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { CodecParseResult } from '../../errors.js'
import type { serializeSpatial } from '../../spatial/spatial-core.js'
import {
  decode as decodeBits,
  type Encoded,
  encode as encodeBits,
} from '../frontmatter-oracle/oracle.js'

/**
 * The answers recorded from the TypeScript JSON Canvas codec, before its writer
 * was deleted, that the Rust codec is held to
 * (`crates/core/codec/tests/json_canvas_oracle.rs`), and that the viewer's
 * TypeScript reader is held to as well.
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

/** How a canvas is written: the second argument of `serializeSpatial`. */
type SpatialSerializeMode = Parameters<typeof serializeSpatial>[1]

/** A reader of JSON Canvas text: the core through codec's export, or the viewer's own. */
export type Reader = (text: string) => CodecParseResult<SpatialCanvas>

/** A writer of JSON Canvas text: the core through codec's export. */
export type Writer = (canvas: SpatialCanvas, mode: SpatialSerializeMode) => string

/** Why a reader or writer declined, as the codec words it: the core's detail, in parentheses. */
const declineReason = (message: string): string | undefined =>
  /refused its input: [\w-]+ \(([\w-]+)\)/.exec(message)?.[1]

/** How a reader answers `t`: the document, a refusal, or `declined` with the core's reason. */
export function readerCase(
  read: Reader,
  t: string,
): ReaderCase | { k: 'r'; t: string; declined: string } {
  const result = read(t)
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
  const declined = declineReason(message)
  if (declined !== undefined) return { k: 'r', t, declined }
  if (!message.startsWith('this file carries x-whiteboard.comments')) {
    throw new Error(`a refusal the oracle has no class for: ${message}`)
  }
  return { k: 'r', t, err: { stage: 'json-canvas-schema', class: 'conversation' } }
}

/** The canvas a recorded writer case holds. */
export const canvasOf = (c: WriterCase['c']): SpatialCanvas => decode(c) as SpatialCanvas

/** How a writer answers a recorded canvas: the text, the strict mode's issues, or `declined`. */
export function writerCase(
  write: Writer,
  c: Compact,
  m: SpatialSerializeMode,
): WriterCase | { k: 'w'; m: SpatialSerializeMode; c: Compact; declined: string } {
  try {
    return { k: 'w', m, c, y: write(canvasOf(c), m) }
  } catch (error) {
    const { issues, message } = error as {
      issues?: { path: PropertyKey[]; code: string }[]
      message?: string
    }
    if (issues === undefined) throw error
    const declined = declineReason(message ?? '')
    if (declined !== undefined) return { k: 'w', m, c, declined }
    return { k: 'w', m, c, err: { issues: issuesOf(issues) } }
  }
}

export function decodeRecording(text: string): RecordedCase[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as RecordedCase)
}
