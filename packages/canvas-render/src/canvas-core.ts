import type {
  CommentMessage,
  CommentThread,
  Proposal,
  ProposedChange,
  SpatialCanvas,
} from '@kamiazya/whiteboard-model'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { BoundingBox, Scene } from '@kamiazya/whiteboard-scene'
import type { FragmentAsk, FragmentEntry } from './fragment-ask.js'
import type { CodeTokenLines } from './highlight/code-token.js'
import type { EdgeAnchorOverride, EdgeAnchorPair } from './layout/edges/edge-sides.js'
import type { MeasureSpec, MeasureText } from './measure.js'
import type { LoadedReference } from './references/loaded-reference.js'
import type { ReferenceExtra } from './references/wire.js'
import type { LayoutRefusal } from './refusal.js'
import type { SpatialGeometry } from './theme/spatial-geometry.js'
import type { SpatialThemeMode } from './theme/spatial-theme.js'

/** A reference's surface extras as the core takes them: data only, no body or canvas. */
type CoreExtra = Pick<ReferenceExtra, 'label' | 'missing' | 'pending' | 'image' | 'facets'>

/** A thread as the core takes it: what a layout reads of one, no author or timestamp. */
export type CoreThread = Pick<CommentThread, 'id' | 'anchor' | 'status'> & {
  readonly messages: readonly Pick<CommentMessage, 'id' | 'body'>[]
}

/**
 * A change as the core takes it: a passage change by its identity and verdict
 * alone, since the canvas only counts one.
 */
export type CoreChange =
  | Exclude<ProposedChange, { op: 'body.replace' }>
  | Pick<Extract<ProposedChange, { op: 'body.replace' }>, 'id' | 'status' | 'op'>

/** A proposal as the core takes it: what a layout reads of one, no author or timestamp. */
export type CoreProposal = Pick<Proposal, 'id'> & { readonly changes: readonly CoreChange[] }

/**
 * One layout asked of the Rust core (ADR-0054 step 7), every option as data:
 * the measurer and the appearance by name, the references as the tables
 * their seams were rebuilt from, and the caller's expansion policy settled
 * ahead: one answer for every file node, or the ids of the ones drawn open.
 * Built only for a layout the core draws exactly as the TypeScript does
 * (`canvasLayoutRequest`).
 */
export interface CanvasLayoutRequest {
  readonly canvas: SpatialCanvas
  readonly measure: MeasureSpec
  readonly mode: SpatialThemeMode
  /** `'document'` or a theme id; absent, the clean style. */
  readonly style?: string
  /** The families a bundled theme names that the surface holds a face for. */
  readonly fontFamilies?: readonly string[]
  readonly geometry?: SpatialGeometry
  readonly lockedNodeIds?: readonly string[]
  readonly suppressedBodyNodeIds?: readonly string[]
  readonly sideOverrides?: readonly (readonly [string, EdgeAnchorOverride])[]
  readonly tagLibrary?: TagLibrary
  readonly embedPath?: readonly string[]
  readonly references?: {
    readonly entries: readonly (readonly [string, LoadedReference | null])[]
    readonly aliases: readonly (readonly [string, string])[]
    readonly titles: readonly (readonly [string, string])[]
    readonly extras: readonly (readonly [string, CoreExtra])[]
  }
  readonly expand: boolean | readonly string[]
  readonly threads?: readonly CoreThread[]
  readonly commentLayer?: boolean
  readonly showResolved?: boolean
  readonly commentObstacles?: readonly BoundingBox[]
  /**
   * The rendered math blocks and fences by key; present, the answer carries
   * the sources the table could not answer as `fragmentsAsked`.
   */
  readonly fragments?: readonly FragmentEntry[]
  readonly proposals?: readonly CoreProposal[]
}

/** The degradations a layout reports, as the core can report them: no thrown value rides along. */
export type CoreDegradation =
  | { readonly kind: 'body-parse-failed'; readonly nodeId: string }
  | { readonly kind: 'unknown-theme'; readonly theme: string }
  | { readonly kind: 'font-missing'; readonly family: string }
  | { readonly kind: 'unknown-node-kind'; readonly nodeId: string; readonly type: string }
  | {
      readonly kind: 'unsupported-background-style'
      readonly nodeId: string
      readonly style: 'repeat'
    }

/**
 * The core's answer: the layout, or what it refused (a request past its caps,
 * a number its answer cannot spell, a host measurer that did not answer,
 * faces past what the instance holds), which a surface draws as a refusal.
 */
type CanvasLayoutAnswer =
  | {
      readonly scene: Scene
      readonly anchors: ReadonlyMap<string, EdgeAnchorPair>
      readonly degradations: readonly CoreDegradation[]
      /** For a request carrying `fragments`: the sources it could not answer, once each in the order asked. */
      readonly fragmentsAsked?: readonly FragmentAsk[]
    }
  | { readonly refused: LayoutRefusal }

/**
 * The Rust core's one-call layout, as `@kamiazya/whiteboard-core-wasm`'s
 * `Core` answers it; declared here, structurally, as `RoutingCore` is.
 */
export interface CanvasLayoutCore {
  /**
   * `highlight` tokenises exactly the fences the core finds the default
   * highlighter would colour: the core holds the gate, never the grammars.
   * `measure` is the layout's own measurer, which the core asks mid-layout
   * when the request names it `host`. `cache` is the caller's content cache
   * (`SpatialContentCache`), named by its identity alone: the core keeps its
   * own laid-out bodies for as long as that object lives, and never reads or
   * writes the object.
   */
  layoutSpatialCanvas(
    request: CanvasLayoutRequest,
    highlight: (lang: string, value: string) => CodeTokenLines | undefined,
    measure: MeasureText,
    cache?: object,
  ): CanvasLayoutAnswer
}
