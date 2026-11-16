import { parseMarkdownBody, resolveReferences } from '@kamiazya/whiteboard-codec'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { Scene } from '@kamiazya/whiteboard-scene'
import { highlightCode } from '../highlight/lowlight.js'
import type {
  MarkdownBodyRequest,
  MarkdownCommentRequest,
  MarkdownLayoutAnswer,
  MarkdownLayoutCore,
  MarkdownLayoutSkip,
  MarkdownNoteRequest,
} from '../markdown-core.js'
import { type MeasureText, measureSpecOf } from '../measure.js'
import type { ReferenceSeams } from '../references/seams.js'
import { wireOfSeams } from '../references/wire.js'
import { SPATIAL_THEME_FONT_FAMILY } from '../theme/font-family.js'
import { MARKDOWN_THEME_DOCUMENT } from '../theme/markdown-theme.js'
import { createSpatialTheme, type SpatialThemeMode } from '../theme/spatial-theme.js'
import { firstDifference, hasData, styleOptions, valueAt } from './canvas-switch.js'
import {
  COMMENT_TEXT_MAX_WIDTH_PX,
  type CommentBodyLayoutOptions,
  layoutCommentBody,
} from './comment-body.js'
import type { CoreImpl, LayoutCore } from './edges/layout-core.js'
import type { SpatialRenderStyle } from './layout-options.js'
import { layoutMdastBlocks } from './markdown-body.js'
import { type FragmentAsk, type FragmentEntry, fragmentAskKey } from './nodes/fragment-ask.js'
import type { RenderedSvgFragment } from './nodes/mdast-layout-options.js'
import { selectMarkdownSection } from './nodes/mdast-section.js'

// A markdown body's switch (ADR-0054 step 7, S18c): which notes and which
// comments the Rust core's markdown entry can be handed, and who answers one
// under `ts`, `differential` and `rust`.

/**
 * A markdown DOCUMENT laid out as a page: the document theme, the bundled
 * family, every option data a request can carry. What a surface may vary is
 * what a board the note embeds is drawn with, and what the note points at.
 */
export interface MarkdownDocumentOptions {
  readonly measure: MeasureText
  readonly maxWidth: number
  /** The bundled theme a board the note embeds is painted in; absent, light. */
  readonly mode?: SpatialThemeMode
  /** Which look an embedded board is drawn in (`layoutMdastBlocks`' `style`); absent, clean. */
  readonly style?: SpatialRenderStyle
  /** Whether a family an embedded board's theme names can be measured here. */
  readonly fontAvailable?: (family: string) => boolean
  /** The workspace's tag library, so an embedded board is coloured by intent. */
  readonly tagLibrary?: TagLibrary
  /** What the note's links and embeds resolve through; absent, nothing resolves. */
  readonly references?: ReferenceSeams
  /**
   * The rendered math blocks and diagram fences by `fragmentAskKey`; a source
   * the table lacks is drawn as its fallback and handed to `onFragmentsAsked`
   * once each, in the order asked.
   */
  readonly fragments?: readonly FragmentEntry[]
  readonly onFragmentsAsked?: (asks: readonly FragmentAsk[]) => void
  /** Lay out only the section under this heading (`#Heading`). */
  readonly section?: string
  /** The Rust core and its switch, as a canvas layout takes it. */
  readonly core?: LayoutCore
}

/** A note's request the core can be handed, or why the options cannot be one. */
export type MarkdownLayoutAsk = MarkdownNoteRequest | { readonly skip: MarkdownLayoutSkip }

const usesTable = (options: MarkdownDocumentOptions): boolean =>
  options.fragments !== undefined || options.onFragmentsAsked !== undefined

/**
 * `body` and `options` as a request the core answers exactly as the
 * TypeScript would, or the first reason they cannot be one: a measurer
 * nobody named, or a reference bundle not rebuilt from a wire or one whose
 * extras carry content.
 */
export function markdownLayoutRequest(
  body: string,
  options: MarkdownDocumentOptions,
): MarkdownLayoutAsk {
  const measure = measureSpecOf(options.measure)
  if (measure === undefined) return { skip: 'measure' }
  const wire = options.references === undefined ? undefined : wireOfSeams(options.references)
  if (options.references !== undefined && wire === undefined) return { skip: 'references' }
  if (wire !== undefined && !wire.extras.every(([, extra]) => hasData(extra))) {
    return { skip: 'reference-content' }
  }
  const { tagLibrary, section } = options
  return {
    kind: 'markdown',
    body,
    maxWidth: options.maxWidth,
    measure,
    mode: options.mode ?? 'light',
    ...styleOptions(options),
    ...(tagLibrary === undefined ? {} : { tagLibrary }),
    ...(wire === undefined ? {} : { references: wire }),
    ...(usesTable(options) ? { fragments: options.fragments ?? [] } : {}),
    ...(section === undefined ? {} : { section }),
  }
}

/** The fragment seams answered from the table, and what it lacked, once each in the order asked. */
function fragmentSeams(options: MarkdownDocumentOptions) {
  const rendered = new Map(options.fragments ?? [])
  const asked = new Map<string, FragmentAsk>()
  const answer = (ask: FragmentAsk): RenderedSvgFragment | undefined => {
    const key = fragmentAskKey(ask)
    const found = rendered.get(key)
    if (found === undefined && !asked.has(key)) asked.set(key, ask)
    return found
  }
  const seams = {
    renderMath: (value: string) => answer({ kind: 'math', value }),
    renderDiagram: (lang: string, value: string) => answer({ kind: 'diagram', lang, value }),
  }
  return { seams, asked: () => [...asked.values()] }
}

/** A note laid out by the TypeScript, and the fragment sources it asked for when it was handed a table. */
interface TsNote {
  readonly scene: Scene | undefined
  readonly asked?: readonly FragmentAsk[]
}

function layoutTs(
  body: string,
  options: MarkdownDocumentOptions,
  core: LayoutCore | undefined,
): TsNote {
  const { references, section, style, fontAvailable, tagLibrary } = options
  const whole = resolveReferences(parseMarkdownBody(body), references?.resolveAlias)
  const root = section === undefined ? whole : selectMarkdownSection(whole, section)
  if (root === undefined) return { scene: undefined }
  const table = usesTable(options) ? fragmentSeams(options) : undefined
  const scene = layoutMdastBlocks(root, {
    measure: options.measure,
    maxWidth: options.maxWidth,
    fontFamily: SPATIAL_THEME_FONT_FAMILY,
    theme: MARKDOWN_THEME_DOCUMENT,
    canvasAppearance: createSpatialTheme({ mode: options.mode ?? 'light' }),
    ...(style === undefined ? {} : { style }),
    ...(fontAvailable === undefined ? {} : { fontAvailable }),
    ...(tagLibrary === undefined ? {} : { tagLibrary }),
    ...(references === undefined ? {} : { references }),
    ...(core === undefined ? {} : { core }),
    ...table?.seams,
  })
  return table === undefined ? { scene } : { scene, asked: table.asked() }
}

/** What a note's caller is answered, its fragment listener told what the table lacked. */
function answered(laid: TsNote, options: MarkdownDocumentOptions): Scene | undefined {
  if (laid.asked !== undefined && laid.asked.length > 0) options.onFragmentsAsked?.(laid.asked)
  return laid.scene
}

/**
 * A markdown DOCUMENT laid out as `options.core` says, or `undefined` for a
 * `section` it holds no heading for: by the TypeScript (`layoutMdastBlocks`
 * over the parsed, resolved body) when no core or no markdown core is given,
 * its switch reads `ts`, or the request is one the core cannot be handed;
 * under `rust` by the core's markdown entry; under `differential` by the
 * TypeScript with the core run beside it and any difference in the scene or
 * the fragments asked reported. What the gate skips and what the core
 * declines (each reported by class), and a core that throws (reported), the
 * TypeScript answers, handed the core for a board the note embeds as before.
 *
 * Degradations are not reported: the TypeScript reports none for a note, so
 * a core's are not compared and not forwarded.
 */
export function layoutMarkdownDocument(
  body: string,
  options: MarkdownDocumentOptions,
): Scene | undefined {
  const core = options.core
  const impl = core?.impl.layoutMarkdown ?? 'ts'
  const fallback = () => answered(layoutTs(body, options, core), options)
  if (core?.markdown === undefined || impl === 'ts') return fallback()
  return throughCore(core, core.markdown, impl, markdownLayoutRequest(body, options), {
    measure: options.measure,
    fallback,
    // The TypeScript beside the core is the TypeScript alone: an embedded
    // board handed the core would report its own gate's skips into the count.
    beside: () => layoutTs(body, options, undefined),
    answered: (laid) => answered(laid, options),
  })
}

/** How one body is answered where the core does not answer it, and how a laid-out body reaches its caller. */
interface Answering {
  readonly measure: MeasureText
  /** The TypeScript's answer, handed the core for whatever it lays out in turn. */
  readonly fallback: () => Scene | undefined
  /** The TypeScript's layout to compare the core's with, handed no core. */
  readonly beside: () => TsNote
  readonly answered: (laid: TsNote) => Scene | undefined
}

/**
 * A body whose switch reads `differential` or `rust`, as the core answers it.
 * What the gate skips (reported by class), what the core declines (reported
 * by class) or throws on, and a `missing` answer to a comment, which asks for
 * no section (each reported as refused), the TypeScript answers. Under `rust`
 * the core's answer is the caller's; under `differential` the TypeScript's
 * is, with the first difference in the scene or the fragments asked reported.
 */
function throughCore(
  core: LayoutCore,
  markdown: MarkdownLayoutCore,
  impl: Exclude<CoreImpl, 'ts'>,
  request: MarkdownBodyRequest | { readonly skip: MarkdownLayoutSkip },
  answering: Answering,
): Scene | undefined {
  if ('skip' in request) {
    core.onMismatch?.({ fn: 'layoutMarkdown', kind: 'skipped', reason: request.skip })
    return answering.fallback()
  }
  let answer: MarkdownLayoutAnswer
  try {
    answer = markdown.layoutMarkdown(request, highlightCode, answering.measure)
  } catch (err) {
    core.onMismatch?.({ fn: 'layoutMarkdown', kind: 'refused', err, repro: request })
    return answering.fallback()
  }
  if ('declined' in answer) {
    core.onMismatch?.({ fn: 'layoutMarkdown', kind: 'declined', reason: answer.declined })
    return answering.fallback()
  }
  if ('missing' in answer && request.kind === 'comment') {
    const err = new Error('the core answered a comment as a note missing its section')
    core.onMismatch?.({ fn: 'layoutMarkdown', kind: 'refused', err, repro: request })
    return answering.fallback()
  }
  const rust: TsNote =
    'missing' in answer
      ? { scene: undefined }
      : {
          scene: answer.scene,
          ...(answer.fragmentsAsked === undefined ? {} : { asked: answer.fragmentsAsked }),
        }
  if (impl === 'rust') return answering.answered(rust)
  const ts = answering.beside()
  const comparable = (note: TsNote) => ({ scene: note.scene ?? 'missing', asked: note.asked ?? [] })
  const [tsValue, rustValue] = [comparable(ts), comparable(rust)]
  const at = firstDifference(tsValue, rustValue)
  if (at !== undefined) {
    core.onMismatch?.({
      fn: 'layoutMarkdown',
      kind: 'differs',
      at,
      ts: valueAt(tsValue, at),
      rust: valueAt(rustValue, at),
      repro: request,
    })
  }
  return answering.answered(ts)
}

/**
 * A comment's prose as `CommentBody.tsx` lays it out: the measurer, the room
 * the surface has, and the core. The family is the bundled one and the
 * metrics are the density's, as `layoutCommentBody` fixes them.
 */
export interface CommentDocumentOptions {
  readonly measure: MeasureText
  /** Defaults to `COMMENT_TEXT_MAX_WIDTH_PX`. */
  readonly maxWidth?: number
  readonly density?: NonNullable<CommentBodyLayoutOptions['density']>
  /** The Rust core and its switch; a comment rides the note's (`impl.layoutMarkdown`). */
  readonly core?: LayoutCore
}

/** `body` and `options` as the comment request the core answers as `layoutCommentBody` would, or why not. */
export function commentLayoutRequest(
  body: string,
  options: CommentDocumentOptions,
): MarkdownCommentRequest | { readonly skip: MarkdownLayoutSkip } {
  const measure = measureSpecOf(options.measure)
  if (measure === undefined) return { skip: 'measure' }
  return {
    kind: 'comment',
    body,
    maxWidth: options.maxWidth ?? COMMENT_TEXT_MAX_WIDTH_PX,
    measure,
    density: options.density ?? 'comfortable',
  }
}

/**
 * A comment's prose laid out as `options.core` says: by `layoutCommentBody`
 * when no core or no markdown core is given or its switch reads `ts`, and
 * otherwise through the core's markdown entry under the note's switch,
 * exactly as `layoutMarkdownDocument` answers a note. A comment asks for no
 * fragments and embeds nothing, so only its scene is compared.
 */
export function layoutCommentDocument(body: string, options: CommentDocumentOptions): Scene {
  const ts = (): Scene =>
    layoutCommentBody(body, {
      measure: options.measure,
      fontFamily: SPATIAL_THEME_FONT_FAMILY,
      ...(options.maxWidth === undefined ? {} : { maxWidth: options.maxWidth }),
      ...(options.density === undefined ? {} : { density: options.density }),
    })
  const core = options.core
  const impl = core?.impl.layoutMarkdown ?? 'ts'
  if (core?.markdown === undefined || impl === 'ts') return ts()
  const scene = throughCore(core, core.markdown, impl, commentLayoutRequest(body, options), {
    measure: options.measure,
    fallback: ts,
    beside: () => ({ scene: ts() }),
    answered: (laid) => laid.scene,
  })
  // Never undefined: a `missing` answer to a comment is refused above.
  return scene ?? ts()
}
