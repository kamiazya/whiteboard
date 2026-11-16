import type { SpatialNode } from '@kamiazya/whiteboard-model'
import type { SceneNode } from '@kamiazya/whiteboard-scene'
import type { CanvasLayoutRequest, CanvasLayoutSkip, CoreDegradation } from './canvas-core.js'
import type { CodeTokenLines } from './highlight/code-token.js'
import type { FragmentEntry } from './layout/nodes/fragment-ask.js'
import type { MeasureSpec, MeasureText } from './measure.js'
import type { SpatialThemeMode } from './theme/spatial-theme.js'

/** A box as the query wire carries it, `[x, y, w, h]`. */
export type QueryBox = readonly [number, number, number, number]
/** A point or a size, `[x, y]` or `[w, h]`. */
type QueryPair = readonly [number, number]

/**
 * A layout piece asked of the Rust core on its own (ADR-0054 step 7, S18d's
 * `layout_query`), every argument as data:
 *
 * - `edges`: a canvas request whose edge layer alone is laid out
 *   (`layoutSpatialEdges`), built by `canvasLayoutRequest`;
 * - `node-size`: `fittedTextNodeHeight`; `node-content`: `naturalNodeContentSize`;
 * - `label-placement`: `edgeLabelPlacement`; `label-obstacles`:
 *   `frameTitleObstacles` and then `labelObstacles`, over the scene's runs that
 *   annotate an element;
 * - `comment-bubble`: `placeCommentBubble`;
 * - `outline-content-box`: `outlineContentBox` over the bundled silhouettes.
 */
export type QueryRequest =
  | (CanvasLayoutRequest & { readonly query: 'edges' })
  | {
      readonly query: 'node-size'
      readonly node: SpatialNode
      readonly measure: MeasureSpec
      readonly mode: SpatialThemeMode
      readonly floor: 'ratio' | 'none'
    }
  | {
      readonly query: 'node-content'
      readonly node: SpatialNode
      readonly measure: MeasureSpec
      readonly mode: SpatialThemeMode
      readonly style?: string
      readonly fontFamilies?: readonly string[]
      readonly fragments?: readonly FragmentEntry[]
    }
  | {
      readonly query: 'label-placement'
      readonly path: readonly QueryPair[]
      readonly size: QueryPair
      readonly obstacles: readonly QueryBox[]
      readonly rounded: boolean
    }
  | {
      readonly query: 'label-obstacles'
      readonly nodes: readonly SpatialNode[]
      readonly runs: readonly (readonly ['node' | 'edge', string, QueryBox])[]
    }
  | {
      readonly query: 'comment-bubble'
      readonly anchor: QueryPair
      readonly size: QueryPair
      readonly obstacles: readonly QueryBox[]
    }
  | { readonly query: 'outline-content-box'; readonly shape?: string; readonly box: QueryBox }

/** A number, or a list of them, as the core answers a query other than `edges`. */
export type QueryNumbers = number | readonly QueryNumbers[]

/**
 * The core's answer to a query: an edge layer and what the layout reported
 * beside it, the numbers of any other query (each double exactly as computed),
 * or the class of what it declined, which the TypeScript then answers.
 */
export type QueryAnswer =
  | { readonly nodes: readonly SceneNode[]; readonly degradations: readonly CoreDegradation[] }
  | { readonly numbers: readonly QueryNumbers[] }
  | { readonly declined: string }

/**
 * The Rust core's query entry, as `@kamiazya/whiteboard-core-wasm`'s
 * `Core.layoutQuery` answers it; declared here, structurally, as
 * `CanvasLayoutCore` is. A measured query is measured by `measure` when its
 * request names the host's measurer.
 */
export interface QueryLayoutCore {
  layoutQuery(
    request: QueryRequest,
    highlight: (lang: string, value: string) => CodeTokenLines | undefined,
    measure: MeasureText | undefined,
  ): QueryAnswer
}

/**
 * Why a query's arguments could not be handed to the core: any reason a
 * canvas layout's could not (for `edges`), or an option the core's query does
 * not take (for a node's natural size).
 */
export type QueryLayoutSkip = CanvasLayoutSkip | 'options'

/** A query the core did not answer, by class: skipped by the request gate, or declined by the core. */
export type QueryLayoutTally =
  | { readonly fn: 'layoutQuery'; readonly kind: 'skipped'; readonly reason: QueryLayoutSkip }
  | { readonly fn: 'layoutQuery'; readonly kind: 'declined'; readonly reason: string }

/**
 * A difference `differential` found in a query's answer, or a core that threw
 * on one or answered it in a shape the query does not have: `at` is the path
 * to the first value the two answers part at.
 */
export type QueryLayoutMismatch =
  | {
      readonly fn: 'layoutQuery'
      readonly kind: 'differs'
      readonly at: string
      readonly ts: unknown
      readonly rust: unknown
      readonly repro: QueryRequest
    }
  | {
      readonly fn: 'layoutQuery'
      readonly kind: 'refused'
      readonly err: unknown
      readonly repro: QueryRequest
    }
