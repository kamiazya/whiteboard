import type { Scene } from '@kamiazya/whiteboard-scene'
import { type FenceHighlighter, type FenceRow, FenceTokenMemo } from './fence-tokens.js'
import { LAYOUT_SPATIAL_CANVAS_CAPS, type RefusalCode } from './generated/input-caps.js'
import type { AnchorPair } from './types.js'
import { wireOf } from './value-wire.js'

// The whole layout over the artifact (`crates/bindings/wasm/src/spatial_layout`).
//
// The request and the answer are typed here structurally, as canvas-render's
// `CanvasLayoutRequest` and `CanvasLayoutAnswer`: this package may not import
// canvas-render, which takes this one through its composition roots. Each
// root hands a `Core` over as canvas-render's `LayoutCore`, so the compiler
// holds the two shapes together wherever one is installed.

/** The faces a font-table measurer reads, by family and slot. */
interface LayoutFace {
  readonly family: string
  readonly bold: boolean
  readonly italic: boolean
  readonly bytes: Uint8Array
}

/**
 * A layout request as canvas-render builds it: every field data. Only the
 * measurer is read here; the rest crosses on the value wire as it is.
 */
export interface LayoutRequest {
  readonly measure:
    | { readonly kind: 'fake'; readonly factor: number }
    | { readonly kind: 'ratio' }
    | { readonly kind: 'fonts'; readonly faces: readonly LayoutFace[] }
}

/** One degradation, as the layout reports it. */
type LayoutEvent =
  | { readonly kind: 'body-parse-failed'; readonly nodeId: string }
  | { readonly kind: 'unknown-theme'; readonly theme: string }
  | { readonly kind: 'font-missing'; readonly family: string }
  | { readonly kind: 'unknown-node-kind'; readonly nodeId: string; readonly type: string }
  | {
      readonly kind: 'unsupported-background-style'
      readonly nodeId: string
      readonly style: 'repeat'
    }

/** The artifact's answer: the layout, or what it declined to answer. */
export type LayoutAnswer =
  | {
      readonly scene: Scene
      readonly anchors: ReadonlyMap<string, AnchorPair>
      readonly degradations: readonly LayoutEvent[]
    }
  | { readonly declined: string }

/** The glue call this module makes. */
export interface LayoutGlue {
  layout_spatial_canvas(request: string, fonts: Uint8Array): string
}

/** The errors this module throws, made by the package entry that owns their classes. */
export interface LayoutErrors {
  refused(operation: string, code: RefusalCode, detail?: string): Error
}

/** The request's wire and the fonts argument its faces point into; undefined when the wire cannot carry it. */
function encodeLayoutRequest(
  request: LayoutRequest,
): { text: string; fonts: Uint8Array } | undefined {
  const faces = request.measure.kind === 'fonts' ? request.measure.faces : []
  const fonts = new Uint8Array(faces.reduce((n, face) => n + face.bytes.byteLength, 0))
  let at = 0
  const placed = faces.map(({ bytes, ...face }) => {
    fonts.set(bytes, at)
    at += bytes.byteLength
    return { ...face, from: at - bytes.byteLength, to: at }
  })
  const measure =
    request.measure.kind === 'fonts' ? { kind: 'fonts', faces: placed } : request.measure
  const wire = wireOf({ ...request, measure }, 0, true)
  return wire === undefined ? undefined : { text: JSON.stringify(wire), fonts }
}

const OPERATION = 'layout_spatial_canvas'

/** One call's answer as JSON, or the fences the core asked for. */
type Raw = { readonly needs: (readonly [string, string])[] } | { readonly parsed: unknown[] }

/** The request text with `rows` as its `codeTokens`, spliced into the mapping the base wire closes. */
function withTokens(text: string, rows: readonly FenceRow[]): string | undefined {
  if (rows.length === 0) return text
  const wire = wireOf(rows, 1, true)
  return wire === undefined
    ? undefined
    : `${text.slice(0, -1)},"codeTokens",${JSON.stringify(wire)}]`
}

function call(glue: LayoutGlue, text: string, fonts: Uint8Array): Raw {
  const parsed: unknown = JSON.parse(glue.layout_spatial_canvas(text, fonts))
  const answer = Array.isArray(parsed) ? (parsed as unknown[]) : []
  const code = answer[0] === 'needs' && isRecord(answer[1]) ? answer[1].code : undefined
  return isFences(code) ? { needs: code } : { parsed: answer }
}

/**
 * `layoutSpatialCanvasWithAnchors` over the artifact. A fence the core finds
 * the default highlighter would colour is tokenised by `highlight` and sent
 * on a second call (at most two); `memo` sends the tokens it holds for the
 * request's fences on the first. Answers `declined` for what the core cannot
 * answer exactly as the TypeScript would, a request past its caps and a fence
 * there is no `highlight` for, which a root answers from the TypeScript;
 * throws `CoreInputRefused` for a request the wire does not carry or an answer
 * that is not one, which for a request canvas-render built is a defect.
 */
export function layoutSpatialCanvas(
  glue: LayoutGlue,
  errors: LayoutErrors,
  request: LayoutRequest,
  highlight?: FenceHighlighter,
  memo: FenceTokenMemo = new FenceTokenMemo(),
): LayoutAnswer {
  const encoded = encodeLayoutRequest(request)
  if (encoded === undefined) throw errors.refused(OPERATION, 'malformed', 'wire')
  const send = (rows: readonly FenceRow[]): Raw | { declined: string } => {
    const text = withTokens(encoded.text, rows)
    if (text === undefined) throw errors.refused(OPERATION, 'malformed', 'wire')
    if (text.length + encoded.fonts.byteLength > LAYOUT_SPATIAL_CANVAS_CAPS.maxBytes) {
      return { declined: 'too-large' }
    }
    return call(glue, text, encoded.fonts)
  }
  const held = memo.within(encoded.text)
  let raw = send(held)
  if ('needs' in raw) {
    if (highlight === undefined) return { declined: 'highlight' }
    raw = send([...held, ...memo.answer(raw.needs, highlight)])
  }
  if ('declined' in raw) return raw
  if ('needs' in raw) return { declined: 'highlight' }
  return answerOf(raw.parsed, errors)
}

/** The answer one call gave, read. */
function answerOf([kind, a, b, c]: unknown[], errors: LayoutErrors): LayoutAnswer {
  if (kind === 'declined' && typeof a === 'string') return { declined: a }
  if (kind === 'refused' && a === 'input-too-large' && typeof b === 'string') {
    return { declined: b }
  }
  if (kind === 'ok' && isRecord(a) && Array.isArray(a.nodes) && isAnchors(b) && Array.isArray(c)) {
    return {
      scene: a as unknown as Scene,
      anchors: new Map(b),
      degradations: c as LayoutEvent[],
    }
  }
  const detail = kind === 'refused' && typeof b === 'string' ? b : 'answer'
  throw errors.refused(OPERATION, 'malformed', detail)
}

const isFences = (v: unknown): v is [string, string][] =>
  Array.isArray(v) &&
  v.every(
    (row) =>
      Array.isArray(row) &&
      row.length === 2 &&
      typeof row[0] === 'string' &&
      typeof row[1] === 'string',
  )

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function isAnchors(v: unknown): v is [string, AnchorPair][] {
  return (
    Array.isArray(v) &&
    v.every((row) => Array.isArray(row) && typeof row[0] === 'string' && isRecord(row[1]))
  )
}
