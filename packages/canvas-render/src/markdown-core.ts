import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { Scene } from '@kamiazya/whiteboard-scene'
import type { CoreDegradation, CoreKeyedSvg, CoreSvgAsk } from './canvas-core.js'
import type { FragmentAsk, FragmentEntry } from './fragment-ask.js'
import type { CodeTokenLines } from './highlight/code-token.js'
import type { MeasureSpec, MeasureText } from './measure.js'
import type { ReferenceWire } from './references/wire.js'
import type { LayoutRefusal } from './refusal.js'
import type { SpatialThemeMode } from './theme/spatial-theme.js'

/**
 * A markdown NOTE asked of the Rust core (ADR-0054 step 7, S18b's
 * `kind: 'markdown'`): the body as text, laid out at the document theme in
 * the bundled family exactly as `layoutMdastBlocks` lays one out on every
 * surface, every option as data. `mode`, `style`, `fontFamilies` and
 * `tagLibrary` are what a board the note embeds is drawn with; `references`
 * is the wire its links and embeds resolve through (absent, none resolves);
 * `fragments` answers its math blocks and diagram fences; `section` narrows
 * it to a `#Heading`. Built only by `markdownLayoutRequest`.
 */
export interface MarkdownNoteRequest {
  readonly kind: 'markdown'
  readonly body: string
  readonly maxWidth: number
  readonly measure: MeasureSpec
  readonly mode: SpatialThemeMode
  /** `'document'` or a theme id; absent, the clean style. */
  readonly style?: string
  readonly fontFamilies?: readonly string[]
  readonly tagLibrary?: TagLibrary
  readonly references?: ReferenceWire
  readonly fragments?: readonly FragmentEntry[]
  readonly section?: string
  /** Present, the answer carries the note's SVG as `svg`. */
  readonly svg?: CoreSvgAsk
}

/**
 * A comment's PROSE asked of the Rust core (S18b's `kind: 'comment'`): the
 * body laid out exactly as `layoutCommentBody` lays it out, at the markdown
 * theme its `density` picks, in the bundled family, with nothing resolved.
 * Built only by `commentLayoutRequest`.
 */
export interface MarkdownCommentRequest {
  readonly kind: 'comment'
  readonly body: string
  readonly maxWidth: number
  readonly measure: MeasureSpec
  readonly density: 'comfortable' | 'compact'
  /** Present, the answer carries the comment's SVG. */
  readonly svg?: CoreSvgAsk
}

/** A markdown body the core's markdown entry takes: a note, or a comment's prose. */
type MarkdownBodyRequest = MarkdownNoteRequest | MarkdownCommentRequest

/**
 * The core's answer to a note: the scene; what it refused (a request past its
 * caps, a host measurer that did not answer), which a surface draws as a
 * refusal; or `missing` for a `section` the note holds no heading for.
 */
type MarkdownLayoutAnswer =
  | {
      readonly scene: Scene
      /** The line each top-level block starts on (1-based), index-aligned with the scene's nodes. */
      readonly blockLines: readonly number[]
      readonly degradations: readonly CoreDegradation[]
      /** For a request carrying `fragments`: the sources it could not answer, once each in the order asked. */
      readonly fragmentsAsked?: readonly FragmentAsk[]
      /** For a request carrying `svg`: the scene as the core's SVG backend draws it. */
      readonly svg?: string
      /** For a request carrying `svg` with `form: 'keyed'`: its keyed projection. */
      readonly keyed?: CoreKeyedSvg
    }
  | { readonly refused: LayoutRefusal }
  | { readonly missing: 'section' }

/**
 * The Rust core's markdown entry, as `@kamiazya/whiteboard-core-wasm`'s
 * `Core.layoutMarkdown` answers it; declared here, structurally, as
 * `CanvasLayoutCore` is. `highlight` and `measure` are what
 * `CanvasLayoutCore.layoutSpatialCanvas` takes.
 */
export interface MarkdownLayoutCore {
  layoutMarkdown(
    request: MarkdownBodyRequest,
    highlight: (lang: string, value: string) => CodeTokenLines | undefined,
    measure: MeasureText,
  ): MarkdownLayoutAnswer
}
