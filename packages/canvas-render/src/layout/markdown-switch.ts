import { parseMarkdownBody, resolveReferences } from '@kamiazya/whiteboard-codec'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { Scene } from '@kamiazya/whiteboard-scene'
import { COMMENT_TEXT_MAX_WIDTH_PX } from '../comment-geometry.js'
import { type FragmentAsk, type FragmentEntry, fragmentAskKey } from '../fragment-ask.js'
import { highlightCode } from '../highlight/lowlight.js'
import type { MarkdownCommentRequest, MarkdownNoteRequest } from '../markdown-core.js'
import { type MeasureText, measureSpecOf } from '../measure.js'
import type { ReferenceSeams } from '../references/seams.js'
import { wireOfSeams } from '../references/wire.js'
import { type LayoutRefusal, refusalScene } from '../refusal.js'
import { SPATIAL_THEME_FONT_FAMILY } from '../theme/font-family.js'
import { MARKDOWN_THEME_DOCUMENT } from '../theme/markdown-theme.js'
import { createSpatialTheme, type SpatialThemeMode } from '../theme/spatial-theme.js'
import { CoreUnaskable, hasData, styleOptions } from './canvas-switch.js'
import { type CommentBodyLayoutOptions, layoutCommentBody } from './comment-body.js'
import type { LayoutCore } from './edges/layout-core.js'
import type { SpatialRenderStyle } from './layout-options.js'
import { layoutMdastBlocks } from './markdown-body.js'
import type { RenderedSvgFragment } from './nodes/mdast-layout-options.js'
import { selectMarkdownSection } from './nodes/mdast-section.js'

// A markdown body through the Rust core's markdown entry (ADR-0054 step 7,
// S18c): the request a note or a comment makes, and what a surface is answered
// with. Handed a core, the core answers; handed none, the TypeScript does.

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
  /** The Rust core, as a canvas layout takes it; absent, the TypeScript lays the note out. */
  readonly core?: LayoutCore
  /**
   * Told when the core refused the note (`SpatialLayoutOptions`'
   * `onRefused`); the scene answered is then the refusal, at `maxWidth`.
   */
  readonly onRefused?: (refusal: LayoutRefusal) => void
}

const usesTable = (options: MarkdownDocumentOptions): boolean =>
  options.fragments !== undefined || options.onFragmentsAsked !== undefined

/**
 * `body` and `options` as the request the core answers. Throws `CoreUnaskable`
 * for a measurer nobody named, or a reference bundle not rebuilt from a wire
 * or one whose extras carry content.
 */
export function markdownLayoutRequest(
  body: string,
  options: MarkdownDocumentOptions,
): MarkdownNoteRequest {
  const measure = measureSpecOf(options.measure)
  if (measure === undefined) throw new CoreUnaskable('measure')
  const wire = options.references === undefined ? undefined : wireOfSeams(options.references)
  if (options.references !== undefined && wire === undefined) {
    throw new CoreUnaskable('references')
  }
  if (wire !== undefined && !wire.extras.every(([, extra]) => hasData(extra))) {
    throw new CoreUnaskable('reference-content')
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

function layoutTs(body: string, options: MarkdownDocumentOptions): TsNote {
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
 * A markdown DOCUMENT laid out by `options.core`'s markdown entry, or by the
 * TypeScript (`layoutMdastBlocks` over the parsed, resolved body) when it is
 * handed none; `undefined` for a `section` it holds no heading for. What the
 * core refused is drawn as the refusal at `maxWidth` and told to
 * `onRefused`; a core that throws throws to the caller.
 *
 * Degradations are not reported: a note reports none.
 */
export function layoutMarkdownDocument(
  body: string,
  options: MarkdownDocumentOptions,
): Scene | undefined {
  const core = options.core
  if (core === undefined) return answered(layoutTs(body, options), options)
  const answer = core.markdown.layoutMarkdown(
    markdownLayoutRequest(body, options),
    highlightCode,
    options.measure,
  )
  if ('refused' in answer) {
    const refusal = answer.refused
    options.onRefused?.(refusal)
    const mode = options.mode ?? 'light'
    return refusalScene(refusal, { measure: options.measure, mode, maxWidth: options.maxWidth })
  }
  if ('missing' in answer) return undefined
  const { scene, fragmentsAsked } = answer
  return answered(
    fragmentsAsked === undefined ? { scene } : { scene, asked: fragmentsAsked },
    options,
  )
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
  /** The Rust core, whose markdown entry lays a comment out as a note's; absent, the TypeScript does. */
  readonly core?: LayoutCore
}

/** `body` and `options` as the comment request the core answers as `layoutCommentBody` would. */
function commentLayoutRequest(
  body: string,
  options: CommentDocumentOptions,
): MarkdownCommentRequest {
  const measure = measureSpecOf(options.measure)
  if (measure === undefined) throw new CoreUnaskable('measure')
  return {
    kind: 'comment',
    body,
    maxWidth: options.maxWidth ?? COMMENT_TEXT_MAX_WIDTH_PX,
    measure,
    density: options.density ?? 'comfortable',
  }
}

/**
 * A comment's prose laid out by `options.core`'s markdown entry, exactly as
 * `layoutMarkdownDocument` answers a note, or by `layoutCommentBody` when it
 * is handed none. What the core refused is drawn as the refusal.
 */
export function layoutCommentDocument(body: string, options: CommentDocumentOptions): Scene {
  const core = options.core
  if (core === undefined) {
    return layoutCommentBody(body, {
      measure: options.measure,
      fontFamily: SPATIAL_THEME_FONT_FAMILY,
      ...(options.maxWidth === undefined ? {} : { maxWidth: options.maxWidth }),
      ...(options.density === undefined ? {} : { density: options.density }),
    })
  }
  const answer = core.markdown.layoutMarkdown(
    commentLayoutRequest(body, options),
    highlightCode,
    options.measure,
  )
  if ('refused' in answer) {
    return refusalScene(answer.refused, {
      measure: options.measure,
      mode: 'light',
      maxWidth: options.maxWidth ?? COMMENT_TEXT_MAX_WIDTH_PX,
    })
  }
  if ('missing' in answer) {
    throw new Error('the core answered a comment as a note missing its section')
  }
  return answer.scene
}
