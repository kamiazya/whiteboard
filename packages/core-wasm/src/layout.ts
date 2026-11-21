import type { Scene } from '@kamiazya/whiteboard-scene'
import { type FenceHighlighter, type FenceRow, FenceTokenMemo } from './fence-tokens.js'
import type { FontHandles, FontsGlue, LayoutFaces } from './font-handles.js'
import {
  LAYOUT_QUERY_CAPS,
  LAYOUT_SPATIAL_CANVAS_CAPS,
  type RefusalCode,
} from './generated/input-caps.js'
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

/** A math block or fence the request's `fragments` table did not hold. */
type FragmentAsk =
  | { readonly kind: 'math'; readonly value: string }
  | { readonly kind: 'diagram'; readonly lang: string; readonly value: string }

/**
 * A layout the core refused, which a root draws as a refusal (owner decision
 * q81, D7): a request past one of its caps (`input-too-large`, `reason`
 * naming the cap), a layout holding a number its answer cannot spell
 * (`malformed`, `non-finite`), or a host measurer that did not answer
 * (`malformed`, `host-measure`).
 */
export interface LayoutRefusal {
  readonly code: RefusalCode
  readonly reason: string
}

/** The refusals a root draws, by code; any other refusal is a defect, and thrown. */
const DRAWN: Readonly<Record<RefusalCode, (reason: string) => boolean>> = {
  'input-too-large': () => true,
  malformed: (reason) => reason === 'non-finite' || reason === 'host-measure',
}

/** The refusal `answer` spells, when it is one a root draws. */
export function drawnRefusal([kind, code, reason]: unknown[]): LayoutRefusal | undefined {
  if (kind !== 'refused' || typeof reason !== 'string') return undefined
  if (code !== 'input-too-large' && code !== 'malformed') return undefined
  return DRAWN[code](reason) ? { code, reason } : undefined
}

/** A request past the entry's bytes, refused here before the core is asked. */
const TOO_LARGE: { readonly refused: LayoutRefusal } = {
  refused: { code: 'input-too-large', reason: 'too-large' },
}

/** The artifact's answer: the layout, or what it refused. */
export type LayoutAnswer =
  | {
      readonly scene: Scene
      readonly anchors: ReadonlyMap<string, AnchorPair>
      readonly degradations: readonly LayoutEvent[]
      /** For a request carrying `fragments`: what the table did not hold. */
      readonly fragmentsAsked?: readonly FragmentAsk[]
      /** For a request carrying `svg`: the scene as the core's SVG backend draws it. */
      readonly svg?: string
      /** For a request carrying `svg` with `form: 'keyed'`: its keyed projection. */
      readonly keyed?: KeyedSvg
    }
  | { readonly refused: LayoutRefusal }

/**
 * The SVG a request asks to be answered with beside its scene: the core's
 * backend over the laid-out scene, with the envelope options the ask names.
 * The view box names no box, since the caller has no scene to measure
 * beforehand: `'document'` is the scene's document bounds (an empty box for a
 * scene with no node, the server's envelope), and `{of, margin?}` is
 * `sceneBounds` (`of: 'scene'`) or `sceneDocumentBounds(scene, margin)`
 * (`of: 'document'`) grown by `margin`, their 1x1 fallback included.
 * `form: 'keyed'` answers the keyed projection instead of the document.
 */
export interface SvgAsk {
  readonly viewBox?: 'document' | { readonly of: 'scene' | 'document'; readonly margin?: number }
  readonly width?: number
  readonly height?: number
  readonly padding?: number
  readonly background?: string
  readonly textFill?: string
  readonly rasterScale?: number
  readonly legend?: 'omit'
  readonly form?: 'keyed'
}

/** One group of a keyed projection; `annotation` marks the annotation layer's. */
interface KeyedGroup {
  readonly key: string
  readonly svg: string
  readonly annotation?: true
}

/**
 * A keyed projection, as canvas-render's `KeyedSvgRender` holds one: the
 * document (rebuilt here as the root, the groups and the close, which is what
 * it is), the root's open tag and attributes, and the groups.
 */
export interface KeyedSvg {
  readonly svg: string
  readonly rootOpen: string
  readonly rootAttrs: Readonly<Record<string, string>>
  readonly groups: readonly KeyedGroup[]
}

const isPair = (v: unknown): v is [string, string] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string'

function groupOf(row: unknown): KeyedGroup | undefined {
  if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string') {
    return undefined
  }
  if (row.length === 2) return { key: row[0], svg: row[1] }
  return row.length === 3 && row[2] === true
    ? { key: row[0], svg: row[1], annotation: true }
    : undefined
}

/** The keyed projection the core answered as `[rootOpen, attrs, groups]`, or undefined when it is not one. */
function keyedOf(item: unknown): KeyedSvg | undefined {
  if (!Array.isArray(item) || item.length !== 3) return undefined
  const [rootOpen, attrs, rows] = item as unknown[]
  if (typeof rootOpen !== 'string' || !Array.isArray(attrs) || !attrs.every(isPair)) {
    return undefined
  }
  if (!Array.isArray(rows)) return undefined
  const groups = rows.map(groupOf)
  if (groups.includes(undefined)) return undefined
  const read = groups as KeyedGroup[]
  return {
    svg: `${rootOpen}${read.map((group) => group.svg).join('')}</svg>`,
    rootOpen,
    rootAttrs: Object.fromEntries(attrs),
    groups: read,
  }
}

/** An answer's trailing SVG item: the document's text, or a keyed projection. */
export function pictureOf(
  item: unknown,
): { readonly svg: string } | { readonly keyed: KeyedSvg } | undefined {
  if (typeof item === 'string') return { svg: item }
  const keyed = keyedOf(item)
  return keyed === undefined ? undefined : { keyed }
}

/** The glue calls this module makes. */
export interface LayoutGlue extends FontsGlue, CachesGlue {
  layout_spatial_canvas(request: string, host?: HostMeasurer): string
  layout_query(request: string, host?: HostMeasurer): string
}

/** The two exports a measured request is sent to: the whole layout, and the queries. */
type LayoutEntry = 'layout_spatial_canvas' | 'layout_query'

/** The most request text each entry reads. */
const MAX_BYTES: Readonly<Record<LayoutEntry, number>> = {
  layout_spatial_canvas: LAYOUT_SPATIAL_CANVAS_CAPS.maxBytes,
  layout_query: LAYOUT_QUERY_CAPS.maxBytes,
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
  const wire = wireOf({ ...request, measure, ...cache }, 0, true, true)
  return wire === undefined ? undefined : JSON.stringify(wire)
}

const OPERATION: LayoutEntry = 'layout_spatial_canvas'

/** One call's answer as JSON, the fences the core asked for, or a handle it holds nothing under. */
type Raw =
  | { readonly needs: (readonly [string, string])[] }
  | { readonly parsed: unknown[] }
  | { readonly lost: true }

/** What a layout call answers when it is not the caller's own answer. */
type Unanswered = { readonly refused: LayoutRefusal }

/** The request text with `rows` as its `codeTokens`, spliced into the mapping the base wire closes. */
function withTokens(text: string, rows: readonly FenceRow[]): string | undefined {
  if (rows.length === 0) return text
  const wire = wireOf(rows, 1, true)
  return wire === undefined
    ? undefined
    : `${text.slice(0, -1)},"codeTokens",${JSON.stringify(wire)}]`
}

function call(
  glue: LayoutGlue,
  entry: LayoutEntry,
  text: string,
  host: HostMeasurer | undefined,
): Raw {
  const parsed: unknown = JSON.parse(glue[entry](text, host))
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
 * text and font; without one it is refused. Answers `refused` for a request
 * past its caps, a layout holding a number the answer cannot spell, a host
 * measurer that did not answer and faces past what the instance holds, which a
 * root draws as a refusal (a body past the parser's bounds is drawn as its
 * literal text, owner decision q81 D7a, and declines nothing); throws
 * `CoreInputRefused` for a request the wire does not carry, a fence there is
 * no `highlight` for, or an answer that is not one, which for a request
 * canvas-render built is a defect.
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

/**
 * What every layout call goes through: the glue, its errors, the fences' memo
 * and the faces' handles; and the export called, the whole layout's unless named.
 */
export interface Calls {
  readonly entry?: LayoutEntry
  readonly glue: LayoutGlue
  readonly errors: LayoutErrors
  readonly highlight: FenceHighlighter | undefined
  readonly memo: FenceTokenMemo
  readonly fonts: FontHandles
}

/** How the last call's answer is read into what the caller is answered. */
export type Read<A> = (parsed: unknown[], errors: LayoutErrors) => A

/** A layout through `calls`, its last answer read by `read`; see `layoutSpatialCanvas`. */
export function layoutWith<A>(
  { entry = OPERATION, glue, errors, highlight, memo, fonts }: Calls,
  request: LayoutRequest,
  read: Read<A>,
  hostMeasure: HostMeasure | undefined,
  surface: number | undefined,
): A | Unanswered {
  const { measure } = request
  const host =
    measure.kind === 'host' && hostMeasure !== undefined ? hostMeasurerOf(hostMeasure) : undefined
  const once = (): A | Unanswered | 'lost' => {
    const named = measure.kind === 'fonts' ? fonts.handleOf(measure) : undefined
    if (named !== undefined && 'declined' in named) {
      // Faces the core will not hold: a root keeps its faces within the caps,
      // so this is an instance past what it holds at once, drawn as a refusal.
      return { refused: { code: 'input-too-large', reason: named.declined } }
    }
    const measurer = { handle: named?.handle, host, surface }
    return layoutOnce({ glue, entry, errors }, request, measurer, highlight, memo, read)
  }
  const first = once()
  if (first !== 'lost') return first
  if (measure.kind === 'fonts') fonts.forget(measure)
  const again = once()
  if (again === 'lost') throw errors.refused(entry, 'malformed', 'font-handle')
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
  { glue, entry, errors }: { glue: LayoutGlue; entry: LayoutEntry; errors: LayoutErrors },
  request: LayoutRequest,
  { handle, host, surface }: Measurer,
  highlight: FenceHighlighter | undefined,
  memo: FenceTokenMemo,
  read: Read<A>,
): A | Unanswered | 'lost' {
  const encoded = encodeLayoutRequest(request, handle, surface)
  if (encoded === undefined) throw errors.refused(entry, 'malformed', 'wire')
  const send = (rows: readonly FenceRow[]): Raw | Unanswered => {
    const text = withTokens(encoded, rows)
    if (text === undefined) throw errors.refused(entry, 'malformed', 'wire')
    if (text.length > MAX_BYTES[entry]) return TOO_LARGE
    return call(glue, entry, text, host)
  }
  const held = memo.within(encoded)
  let raw = send(held)
  if ('needs' in raw) {
    if (highlight === undefined) throw errors.refused(entry, 'malformed', 'highlight')
    raw = send([...held, ...memo.answer(raw.needs, highlight)])
  }
  if ('lost' in raw) return 'lost'
  if ('refused' in raw) return raw
  if ('needs' in raw) throw errors.refused(entry, 'malformed', 'highlight')
  return read(raw.parsed, errors)
}

/** The answer one call gave, read. */
function answerOf(parsed: unknown[], errors: LayoutErrors): LayoutAnswer {
  const [kind, a, b, c, ...rest] = parsed
  const refused = drawnRefusal(parsed)
  if (refused !== undefined) return { refused }
  // After the degradations: the fragment sources, when the request carried a
  // table, then the SVG, when it asked for one; each at most once, in that
  // order. A keyed SVG is a list too, but never a list of fragment asks: its
  // first item is the root's text.
  const d = Array.isArray(rest[0]) && isAsks(rest[0]) ? rest[0] : undefined
  const item = rest[d === undefined ? 0 : 1]
  const picture = item === undefined ? {} : pictureOf(item)
  const tail = rest.length === (d === undefined ? 0 : 1) + (item === undefined ? 0 : 1)
  if (
    kind === 'ok' &&
    isRecord(a) &&
    Array.isArray(a.nodes) &&
    isAnchors(b) &&
    Array.isArray(c) &&
    picture !== undefined &&
    tail
  ) {
    return {
      scene: a as unknown as Scene,
      anchors: new Map(b),
      degradations: c as LayoutEvent[],
      ...(d === undefined ? {} : { fragmentsAsked: d }),
      ...picture,
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
 * drawn at the theme its `density` names, its `[[references]]` resolved
 * through `references` as a note's are (none resolve without it).
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
        readonly svg?: SvgAsk
      }
    | {
        readonly kind: 'comment'
        readonly body: string
        readonly maxWidth: number
        readonly density: 'comfortable' | 'compact'
        readonly references?: object
        readonly svg?: SvgAsk
      }
  )

/** The core's markdown layout, what it refused, or a `section` the note does not hold. */
export type MarkdownLayoutAnswer =
  | {
      readonly scene: Scene
      /**
       * The 1-based line each top-level block of the body starts on, index-aligned
       * with the scene's nodes; none for a comment and for a `section`, which is
       * drawn from part of the body. `[1]` for a body past the parser's bounds,
       * which is drawn as one paragraph.
       */
      readonly blockLines: readonly number[]
      readonly degradations: readonly LayoutEvent[]
      /** For a request carrying `fragments`: what the table did not hold. */
      readonly fragmentsAsked?: readonly FragmentAsk[]
      /** For a request carrying `svg`: the scene as the core's SVG backend draws it. */
      readonly svg?: string
      /** For a request carrying `svg` with `form: 'keyed'`: its keyed projection. */
      readonly keyed?: KeyedSvg
    }
  | { readonly refused: LayoutRefusal }
  | { readonly missing: 'section' }

/**
 * A markdown body laid out by the core, over the same calls, caps and
 * answers as `layoutSpatialCanvas`: the scene and its degradations, a
 * `refused` one a root draws as a refusal, or `missing` for a
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

const isBlockLines = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((line) => Number.isInteger(line) && line >= 1)

/**
 * A markdown answer: a canvas's, with the block lines where the anchors would
 * be (a markdown body has none), or a missing section.
 */
function markdownAnswerOf(parsed: unknown[], errors: LayoutErrors): MarkdownLayoutAnswer {
  if (parsed[0] === 'missing' && parsed[1] === 'section') return { missing: 'section' }
  const [kind, scene0, third, ...rest] = parsed
  const blockLines = kind === 'ok' && isBlockLines(third) ? third : []
  const laid = answerOf(blockLines.length > 0 ? [kind, scene0, [], ...rest] : parsed, errors)
  if ('refused' in laid) return laid
  if (laid.anchors.size > 0) throw errors.refused(OPERATION, 'malformed', 'answer')
  const { scene, degradations, fragmentsAsked, svg, keyed } = laid
  return {
    scene,
    blockLines,
    degradations,
    ...(fragmentsAsked === undefined ? {} : { fragmentsAsked }),
    ...(svg === undefined ? {} : { svg }),
    ...(keyed === undefined ? {} : { keyed }),
  }
}
