import type { Scene } from '@kamiazya/whiteboard-scene'
import { type FenceHighlighter, type FenceRow, FenceTokenMemo } from './fence-tokens.js'
import type { FontHandles, FontsGlue, LayoutFaces } from './font-handles.js'
import { LAYOUT_SPATIAL_CANVAS_CAPS, type RefusalCode } from './generated/input-caps.js'
import { type HostMeasure, type HostMeasurer, hostMeasurerOf } from './host-measure.js'
import type { CachesGlue } from './layout-caches.js'
import type { AnchorPair } from './types.js'
import { wireOf } from './value-wire.js'

// The whole layout over the artifact (`crates/bindings/wasm/src/spatial_layout`).
//
// The request and the answer are typed here structurally, as canvas-render's
// `CanvasLayoutRequest` and `CanvasLayoutAnswer`: this package may not import
// canvas-render, which takes this one through its composition roots. Each
// root hands a `Core` over as canvas-render's `LayoutCore`, so the compiler
// holds the two shapes together wherever one is installed.

/**
 * A layout request as canvas-render builds it: every field data. Only the
 * measurer is read here; the rest crosses on the value wire as it is.
 */
export interface LayoutRequest {
  readonly measure:
    | { readonly kind: 'fake'; readonly factor: number }
    | { readonly kind: 'ratio' }
    | { readonly kind: 'host' }
    | LayoutFaces
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

/** A math block or fence the request's `fragments` table did not hold. */
type FragmentAsk =
  | { readonly kind: 'math'; readonly value: string }
  | { readonly kind: 'diagram'; readonly lang: string; readonly value: string }

/** The artifact's answer: the layout, or what it declined to answer. */
export type LayoutAnswer =
  | {
      readonly scene: Scene
      readonly anchors: ReadonlyMap<string, AnchorPair>
      readonly degradations: readonly LayoutEvent[]
      /** For a request carrying `fragments`: what the table did not hold. */
      readonly fragmentsAsked?: readonly FragmentAsk[]
    }
  | { readonly declined: string }

/** The glue calls this module makes. */
export interface LayoutGlue extends FontsGlue, CachesGlue {
  layout_spatial_canvas(request: string, host?: HostMeasurer): string
}

/** The errors this module throws, made by the package entry that owns their classes. */
export interface LayoutErrors {
  refused(operation: string, code: RefusalCode, detail?: string): Error
}

/**
 * The request's wire, its measurer named by `handle` when it reads faces and
 * its content cache by `surface`; undefined when the wire cannot carry it.
 */
function encodeLayoutRequest(
  request: LayoutRequest,
  handle: number | undefined,
  surface: number | undefined,
): string | undefined {
  const measure = handle === undefined ? request.measure : { kind: 'fonts', handle }
  const cache = surface === undefined ? {} : { cache: surface }
  const wire = wireOf({ ...request, measure, ...cache }, 0, true)
  return wire === undefined ? undefined : JSON.stringify(wire)
}

const OPERATION = 'layout_spatial_canvas'

/** One call's answer as JSON, the fences the core asked for, or a handle it holds nothing under. */
type Raw =
  | { readonly needs: (readonly [string, string])[] }
  | { readonly parsed: unknown[] }
  | { readonly lost: true }

/** The request text with `rows` as its `codeTokens`, spliced into the mapping the base wire closes. */
function withTokens(text: string, rows: readonly FenceRow[]): string | undefined {
  if (rows.length === 0) return text
  const wire = wireOf(rows, 1, true)
  return wire === undefined
    ? undefined
    : `${text.slice(0, -1)},"codeTokens",${JSON.stringify(wire)}]`
}

function call(glue: LayoutGlue, text: string, host: HostMeasurer | undefined): Raw {
  const parsed: unknown = JSON.parse(glue.layout_spatial_canvas(text, host))
  const answer = Array.isArray(parsed) ? (parsed as unknown[]) : []
  if (answer[0] === 'refused' && answer[2] === 'font-handle') return { lost: true }
  const code = answer[0] === 'needs' && isRecord(answer[1]) ? answer[1].code : undefined
  return isFences(code) ? { needs: code } : { parsed: answer }
}

/**
 * `layoutSpatialCanvasWithAnchors` over the artifact. A font-table measurer's
 * faces are registered once per measurer in `fonts`, the handles the core
 * holds (one per core, never one per call), and registered again
 * when the core answers that it holds nothing under the handle (an instance
 * recreated since); the layout is then asked once more. `surface` names the
 * content cache the core reads and keeps laid-out bodies in. A fence the core
 * finds the default highlighter would colour is tokenised by `highlight` and
 * sent on a second call (at most two); `memo` sends the tokens it holds for
 * the request's fences on the first. A request naming the host's measurer is
 * measured by `measure`, which the core calls mid-layout once per distinct
 * text and font; without one it is declined. Answers `declined` for what the core
 * cannot answer exactly as the TypeScript would, a request or faces past
 * their caps, faces the core's reader cannot read and a fence there is no
 * `highlight` for, which a root answers from the TypeScript; throws `CoreInputRefused` for a request the wire does
 * not carry or an answer that is not one, which for a request canvas-render
 * built is a defect.
 */
export function layoutSpatialCanvas(
  glue: LayoutGlue,
  errors: LayoutErrors,
  request: LayoutRequest,
  highlight: FenceHighlighter | undefined,
  memo: FenceTokenMemo,
  fonts: FontHandles,
  hostMeasure?: HostMeasure,
  surface?: number,
): LayoutAnswer {
  const calls = { glue, errors, highlight, memo, fonts }
  return layoutWith(calls, request, answerOf, hostMeasure, surface)
}

/** What every layout call goes through: the glue, its errors, the fences' memo and the faces' handles. */
interface Calls {
  readonly glue: LayoutGlue
  readonly errors: LayoutErrors
  readonly highlight: FenceHighlighter | undefined
  readonly memo: FenceTokenMemo
  readonly fonts: FontHandles
}

/** How the last call's answer is read into what the caller is answered. */
type Read<A> = (parsed: unknown[], errors: LayoutErrors) => A

/** A layout through `calls`, its last answer read by `read`; see `layoutSpatialCanvas`. */
function layoutWith<A>(
  { glue, errors, highlight, memo, fonts }: Calls,
  request: LayoutRequest,
  read: Read<A>,
  hostMeasure: HostMeasure | undefined,
  surface: number | undefined,
): A | { readonly declined: string } {
  const { measure } = request
  const host =
    measure.kind === 'host' && hostMeasure !== undefined ? hostMeasurerOf(hostMeasure) : undefined
  const once = (): A | { readonly declined: string } | 'lost' => {
    const named = measure.kind === 'fonts' ? fonts.handleOf(measure) : undefined
    if (named !== undefined && 'declined' in named) return named
    const measurer = { handle: named?.handle, host, surface }
    return layoutOnce(glue, errors, request, measurer, highlight, memo, read)
  }
  const first = once()
  if (first !== 'lost') return first
  if (measure.kind === 'fonts') fonts.forget(measure)
  const again = once()
  if (again === 'lost') throw errors.refused(OPERATION, 'malformed', 'font-handle')
  return again
}

/** How a call measures: the faces' handle, or the host's measurer; and the surface it caches under. */
interface Measurer {
  readonly handle: number | undefined
  readonly host: HostMeasurer | undefined
  readonly surface: number | undefined
}

/** One layout over `measurer`, the fences asked for included; `lost` when the core holds no faces under its handle. */
function layoutOnce<A>(
  glue: LayoutGlue,
  errors: LayoutErrors,
  request: LayoutRequest,
  { handle, host, surface }: Measurer,
  highlight: FenceHighlighter | undefined,
  memo: FenceTokenMemo,
  read: Read<A>,
): A | { readonly declined: string } | 'lost' {
  const encoded = encodeLayoutRequest(request, handle, surface)
  if (encoded === undefined) throw errors.refused(OPERATION, 'malformed', 'wire')
  const send = (rows: readonly FenceRow[]): Raw | { declined: string } => {
    const text = withTokens(encoded, rows)
    if (text === undefined) throw errors.refused(OPERATION, 'malformed', 'wire')
    if (text.length > LAYOUT_SPATIAL_CANVAS_CAPS.maxBytes) return { declined: 'too-large' }
    return call(glue, text, host)
  }
  const held = memo.within(encoded)
  let raw = send(held)
  if ('needs' in raw) {
    if (highlight === undefined) return { declined: 'highlight' }
    raw = send([...held, ...memo.answer(raw.needs, highlight)])
  }
  if ('lost' in raw) return 'lost'
  if ('declined' in raw) return raw
  if ('needs' in raw) return { declined: 'highlight' }
  return read(raw.parsed, errors)
}

/** The answer one call gave, read. */
function answerOf([kind, a, b, c, d]: unknown[], errors: LayoutErrors): LayoutAnswer {
  if (kind === 'declined' && typeof a === 'string') return { declined: a }
  if (kind === 'refused' && a === 'input-too-large' && typeof b === 'string') {
    return { declined: b }
  }
  const asked = d === undefined || isAsks(d)
  if (
    kind === 'ok' &&
    isRecord(a) &&
    Array.isArray(a.nodes) &&
    isAnchors(b) &&
    Array.isArray(c) &&
    asked
  ) {
    return {
      scene: a as unknown as Scene,
      anchors: new Map(b),
      degradations: c as LayoutEvent[],
      ...(d === undefined ? {} : { fragmentsAsked: d }),
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

const isAsks = (v: unknown): v is FragmentAsk[] =>
  Array.isArray(v) &&
  v.every(
    (ask) =>
      isRecord(ask) &&
      typeof ask.value === 'string' &&
      (ask.kind === 'math' || (ask.kind === 'diagram' && typeof ask.lang === 'string')),
  )

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function isAnchors(v: unknown): v is [string, AnchorPair][] {
  return (
    Array.isArray(v) &&
    v.every((row) => Array.isArray(row) && typeof row[0] === 'string' && isRecord(row[1]))
  )
}

/**
 * A markdown body laid out by the core as data, as canvas-render's
 * `layoutMdastBlocks` and `layoutCommentBody` take it; typed structurally,
 * like `LayoutRequest`, since this package may not import canvas-render. A
 * note (`kind: 'markdown'`) is drawn at the document theme with its embeds
 * resolved from `references` (none resolve without it), each embedded board
 * in `mode` and `style` with the families in `fontFamilies`, coloured by
 * `tagLibrary`; `fragments` answers its math blocks and diagram fences, and
 * `section` narrows it to a `#Heading`. A comment (`kind: 'comment'`) is
 * drawn at the theme its `density` names, with nothing resolved.
 */
export type MarkdownLayoutRequest = LayoutRequest &
  (
    | {
        readonly kind: 'markdown'
        readonly body: string
        readonly maxWidth: number
        readonly mode: 'light' | 'dark'
        readonly style?: string
        readonly fontFamilies?: readonly string[]
        readonly tagLibrary?: object
        readonly references?: object
        readonly fragments?: readonly (readonly [string, object])[]
        readonly section?: string
      }
    | {
        readonly kind: 'comment'
        readonly body: string
        readonly maxWidth: number
        readonly density: 'comfortable' | 'compact'
      }
  )

/** The core's markdown layout, what it declined, or a `section` the note does not hold. */
export type MarkdownLayoutAnswer =
  | {
      readonly scene: Scene
      readonly degradations: readonly LayoutEvent[]
      /** For a request carrying `fragments`: what the table did not hold. */
      readonly fragmentsAsked?: readonly FragmentAsk[]
    }
  | { readonly declined: string }
  | { readonly missing: 'section' }

/**
 * A markdown body laid out by the core, over the same calls, caps and
 * answers as `layoutSpatialCanvas`: the scene and its degradations, a
 * `declined` class a root answers from the TypeScript, or `missing` for a
 * `section` the note holds no heading for, which a root reports as the
 * TypeScript's section lookup does. Throws `CoreInputRefused` for a request
 * the wire does not carry or an answer that is not one.
 */
export function layoutMarkdown(
  glue: LayoutGlue,
  errors: LayoutErrors,
  request: MarkdownLayoutRequest,
  highlight: FenceHighlighter | undefined,
  memo: FenceTokenMemo,
  fonts: FontHandles,
  hostMeasure?: HostMeasure,
  surface?: number,
): MarkdownLayoutAnswer {
  // A comment's request reads neither fences' tokens, since its prose is
  // coloured by nothing, nor a content cache, since it embeds no board; the
  // core reads strictly, so neither is sent, whatever a note on this core left
  // in the memo or the caller hands as `surface`.
  if (request.kind === 'comment') {
    const calls = { glue, errors, highlight, memo: new FenceTokenMemo(), fonts }
    return layoutWith(calls, request, markdownAnswerOf, hostMeasure, undefined)
  }
  const calls = { glue, errors, highlight, memo, fonts }
  return layoutWith(calls, request, markdownAnswerOf, hostMeasure, surface)
}

/** A markdown answer: a canvas's, its anchors always none, or a missing section. */
function markdownAnswerOf(parsed: unknown[], errors: LayoutErrors): MarkdownLayoutAnswer {
  if (parsed[0] === 'missing' && parsed[1] === 'section') return { missing: 'section' }
  const laid = answerOf(parsed, errors)
  if ('declined' in laid) return laid
  if (laid.anchors.size > 0) throw errors.refused(OPERATION, 'malformed', 'answer')
  const { scene, degradations, fragmentsAsked } = laid
  return { scene, degradations, ...(fragmentsAsked === undefined ? {} : { fragmentsAsked }) }
}
