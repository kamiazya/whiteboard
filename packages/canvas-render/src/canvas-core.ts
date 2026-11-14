import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import type { Scene } from '@kamiazya/whiteboard-scene'
import type { MeasureSpec } from './measure.js'
import type { LoadedReference } from './references/loaded-reference.js'
import type { ReferenceExtra } from './references/wire.js'
import type { SpatialThemeMode } from './theme/spatial-theme.js'
import type { SpatialGeometry } from './theme/spatial-geometry.js'
import type { EdgeAnchorOverride, EdgeAnchorPair } from './layout/edges/edge-sides.js'

/** A reference's surface extras as the core takes them: data only, no body or canvas. */
export type CoreExtra = Pick<ReferenceExtra, 'label' | 'missing' | 'image' | 'facets'>

/**
 * One layout asked of the Rust core (ADR-0054 step 7), every option as data:
 * the measurer and the appearance by name, the references as the tables
 * their seams were rebuilt from, and the caller's expansion policy settled
 * ahead into one answer. Built only for a layout the core draws exactly as
 * the TypeScript does (`canvasLayoutRequest`).
 */
export interface CanvasLayoutRequest {
  readonly canvas: SpatialCanvas
  readonly measure: MeasureSpec
  readonly mode: SpatialThemeMode
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
  readonly expand: boolean
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
 * The core's answer: the layout, or the class of what it declined to answer
 * because it could not answer it exactly as the TypeScript would (a body past
 * the parser's bounds, a shortcode, a coloured fence, a fragment, a request
 * past its caps), which the TypeScript then answers.
 */
export type CanvasLayoutAnswer =
  | {
      readonly scene: Scene
      readonly anchors: ReadonlyMap<string, EdgeAnchorPair>
      readonly degradations: readonly CoreDegradation[]
    }
  | { readonly declined: string }

/**
 * The Rust core's one-call layout, as `@kamiazya/whiteboard-core-wasm`'s
 * `Core` answers it; declared here, structurally, as `RoutingCore` is.
 */
export interface CanvasLayoutCore {
  layoutSpatialCanvas(request: CanvasLayoutRequest): CanvasLayoutAnswer
}

/**
 * A difference `differential` found in a whole layout, or a core that threw
 * on one: `at` is the path to the first value the two answers part at.
 */
export type CanvasLayoutMismatch =
  | {
      readonly fn: 'layoutSpatialCanvas'
      readonly kind: 'differs'
      readonly at: string
      readonly ts: unknown
      readonly rust: unknown
      readonly repro: CanvasLayoutRequest
    }
  | {
      readonly fn: 'layoutSpatialCanvas'
      readonly kind: 'refused'
      readonly err: unknown
      readonly repro: CanvasLayoutRequest
    }
