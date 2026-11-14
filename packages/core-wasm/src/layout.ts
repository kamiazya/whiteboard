import type { Scene } from '@kamiazya/whiteboard-scene'
import { LAYOUT_SPATIAL_CANVAS_CAPS, type RefusalCode } from './generated/input-caps.js'
import type { AnchorPair } from './types.js'
import { wireOf } from './value-wire.js'

// The whole layout over the artifact (`crates/bindings/wasm/src/spatial_layout`).
//
// The request and the answer are typed here structurally, as canvas-render's
// `CanvasLayoutRequest` and `CanvasLayoutAnswer`, which `layout.rust.test.ts`
// in canvas-render holds assignable both ways: this package may not import
// canvas-render, which takes this one through its composition roots.

/** The faces a font-table measurer reads, by family and slot. */
export interface LayoutFace {
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
export type LayoutEvent =
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
export function encodeLayoutRequest(
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

/**
 * `layoutSpatialCanvasWithAnchors` over the artifact. Answers `declined` for
 * what the core cannot answer exactly as the TypeScript would and for a
 * request past its caps, which a root answers from the TypeScript; throws
 * `CoreInputRefused` for a request the wire does not carry or an answer that
 * is not one, which for a request canvas-render built is a defect.
 */
export function layoutSpatialCanvas(
  glue: LayoutGlue,
  errors: LayoutErrors,
  request: LayoutRequest,
): LayoutAnswer {
  const encoded = encodeLayoutRequest(request)
  if (encoded === undefined) throw errors.refused(OPERATION, 'malformed', 'wire')
  if (encoded.text.length + encoded.fonts.byteLength > LAYOUT_SPATIAL_CANVAS_CAPS.maxBytes) {
    return { declined: 'too-large' }
  }
  const parsed: unknown = JSON.parse(glue.layout_spatial_canvas(encoded.text, encoded.fonts))
  const [kind, a, b, c] = Array.isArray(parsed) ? (parsed as unknown[]) : []
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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function isAnchors(v: unknown): v is [string, AnchorPair][] {
  return (
    Array.isArray(v) &&
    v.every((row) => Array.isArray(row) && typeof row[0] === 'string' && isRecord(row[1]))
  )
}
