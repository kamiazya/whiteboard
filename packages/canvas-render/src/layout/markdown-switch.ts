import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { Scene } from '@kamiazya/whiteboard-scene'
import { COMMENT_TEXT_MAX_WIDTH_PX } from '../comment-geometry.js'
import type { FragmentAsk, FragmentEntry } from '../fragment-ask.js'
import { highlightCode } from '../highlight/lowlight.js'
import type { LayoutCore } from '../layout-core.js'
import type { MarkdownCommentRequest, MarkdownNoteRequest } from '../markdown-core.js'
import { type MeasureText, measureSpecOf } from '../measure.js'
import type { ReferenceSeams } from '../references/seams.js'
import { wireOfSeams } from '../references/wire.js'
import { type LayoutRefusal, refusalScene } from '../refusal.js'
import type { SpatialThemeMode } from '../theme/spatial-theme.js'
import { CoreUnaskable, hasData, styleOptions } from './canvas-switch.js'
import type { SpatialRenderStyle } from './layout-options.js'

// A markdown body through the Rust core's markdown entry (ADR-0054 step 7,
// S18c): the request a note or a comment makes, and what a surface is answered
// with. The core is the only typesetter there is (S18h).

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
  /** Which look an embedded board is drawn in; absent, clean. */
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
  /** The Rust core, as a canvas layout takes it. */
  readonly core: LayoutCore
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
 * for a reference bundle not rebuilt from a wire or one whose extras carry
 * content.
 */
export function markdownLayoutRequest(
  body: string,
  options: MarkdownDocumentOptions,
): MarkdownNoteRequest {
  const measure = measureSpecOf(options.measure)
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

/**
 * A markdown DOCUMENT laid out by `options.core`'s markdown entry;
 * `undefined` for a `section` it holds no heading for. What the
 * core refused is drawn as the refusal at `maxWidth` and told to
 * `onRefused`; a core that throws throws to the caller.
 *
 * Degradations are not reported: a note reports none.
 */
export function layoutMarkdownDocument(
  body: string,
  options: MarkdownDocumentOptions,
): Scene | undefined {
  const answer = options.core.markdown.layoutMarkdown(
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
  if (fragmentsAsked !== undefined && fragmentsAsked.length > 0) {
    options.onFragmentsAsked?.(fragmentsAsked)
  }
  return scene
}

/**
 * A comment's prose as `CommentBody.tsx` lays it out: the measurer, the room
 * the surface has, and the core. The family is the bundled one and the
 * metrics are the density's (the core's compact theme or the comfortable
 * comment theme).
 */
export interface CommentDocumentOptions {
  readonly measure: MeasureText
  /** Defaults to `COMMENT_TEXT_MAX_WIDTH_PX`. */
  readonly maxWidth?: number
  readonly density?: 'comfortable' | 'compact'
  /** The Rust core, whose markdown entry lays a comment out as a note's. */
  readonly core: LayoutCore
}

/** `body` and `options` as the comment request the core answers. */
function commentLayoutRequest(
  body: string,
  options: CommentDocumentOptions,
): MarkdownCommentRequest {
  const measure = measureSpecOf(options.measure)
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
 * `layoutMarkdownDocument` answers a note. What the core refused is drawn as
 * the refusal.
 */
export function layoutCommentDocument(body: string, options: CommentDocumentOptions): Scene {
  const answer = options.core.markdown.layoutMarkdown(
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
