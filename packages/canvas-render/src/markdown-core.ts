import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { Scene } from '@kamiazya/whiteboard-scene'
import type { CoreDegradation } from './canvas-core.js'
import type { CodeTokenLines } from './highlight/code-token.js'
import type { FragmentAsk, FragmentEntry } from './layout/nodes/fragment-ask.js'
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
}

/** A markdown body the core's markdown entry takes: a note, or a comment's prose. */
export type MarkdownBodyRequest = MarkdownNoteRequest | MarkdownCommentRequest

/**
 * The core's answer to a note: the scene; what it refused (a request past its
 * caps, a host measurer that did not answer), which a surface draws as a
 * refusal under `rust`; the class of what it declined (a body past the
 * parser's bounds), which the TypeScript then answers; or `missing` for a
 * `section` the note holds no heading for.
 */
export type MarkdownLayoutAnswer =
  | {
      readonly scene: Scene
      readonly degradations: readonly CoreDegradation[]
      /** For a request carrying `fragments`: the sources it could not answer, once each in the order asked. */
      readonly fragmentsAsked?: readonly FragmentAsk[]
    }
  | { readonly declined: string }
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

/**
 * Why a note's options could not be handed to the core: a measurer nobody
 * named, or a reference bundle not rebuilt from a wire or one whose extras
 * carry content.
 */
export type MarkdownLayoutSkip = 'measure' | 'references' | 'reference-content'

/** A note the core did not answer, by class: skipped by the request gate, or declined by the core. */
export type MarkdownLayoutTally =
  | { readonly fn: 'layoutMarkdown'; readonly kind: 'skipped'; readonly reason: MarkdownLayoutSkip }
  | { readonly fn: 'layoutMarkdown'; readonly kind: 'declined'; readonly reason: string }

/**
 * A difference `differential` found in a note's layout, or a core that threw
 * on one: `at` is the path to the first value the two answers part at.
 */
export type MarkdownLayoutMismatch =
  | {
      readonly fn: 'layoutMarkdown'
      readonly kind: 'differs'
      readonly at: string
      readonly ts: unknown
      readonly rust: unknown
      readonly repro: MarkdownBodyRequest
    }
  | {
      readonly fn: 'layoutMarkdown'
      readonly kind: 'refused'
      readonly err: unknown
      readonly repro: MarkdownBodyRequest
    }
