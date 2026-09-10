/**
 * The contract between the renderer and every plugin: what a plugin
 * contributes to drawing a canvas, and the geometry vocabulary those
 * contributions speak.
 *
 * It lives BELOW both, and that is the whole point. It used to live inside
 * the renderer, which made a plugin importing it close a package cycle —
 * held open only by the import being type-only, a property no manifest can
 * see and only a hand-written guard could check. A contract is not the
 * renderer's private type; it belongs where both sides can reach it without
 * reaching for each other.
 */
import type { ThemeTokens } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import type { Appearance, BoundingBox, SceneNode } from './scene-graph.js'

/**
 * A node's silhouette, as a KIND plus numbers derived from its bbox — never
 * stored path coordinates, so translating a scene moves the box and the
 * outline follows, and scaling one scales it implicitly.
 */
export type NodeOutline =
  | {
      readonly kind: 'ellipse'
      readonly cx: number
      readonly cy: number
      readonly rx: number
      readonly ry: number
    }
  | {
      readonly kind: 'polygon'
      readonly points: ReadonlyArray<{ readonly x: number; readonly y: number }>
    }
  | {
      readonly kind: 'cylinder'
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
      /** Lid ellipse's vertical radius: a tenth of the width, capped at a
       * quarter of the height so short nodes keep a visible body. */
      readonly ry: number
    }

/**
 * A silhouette a plugin registers, under a NAMESPACED id.
 *
 * `outline` is the whole contract for painting, hit-testing and edge
 * anchoring, because the renderer's containment test switches on the
 * returned VALUE's kind and its entry-point search bisects against that —
 * one implementation serves every shape, and nothing a contributor supplies
 * can make the drawn and the hit geometry disagree.
 *
 * `contentBox` is the exception, and is optional for a reason: it is a
 * per-shape judgement (how much of the box may text use) that no formula
 * derives from a polygon. A shape that omits it gets the bbox — content may
 * then cross the silhouette, exactly the degradation an unknown id gets.
 *
 * ponytail: a returned polygon must be CONVEX. The renderer answers
 * containment through a convex test and bisects assuming convexity along
 * the probed ray — true of every built-in, and a contract a contributor can
 * break. A concave shape still DRAWS correctly; what degrades is
 * hit-testing and where an edge terminates, both falling back to the convex
 * hull. Lifting it means a general point-in-polygon test plus a ray
 * intersection that does not assume a single crossing, and is worth doing
 * when a contributed concave shape is real rather than a demo.
 */
export interface ShapeContribution {
  readonly outline: (box: BoundingBox) => NodeOutline | null
  readonly contentBox?: (box: BoundingBox) => BoundingBox
}

/**
 * Shapes by namespaced id (`visual.diamond`). The namespace is COMPOSED by
 * the renderer from the declaring facet's key, never read out of a payload —
 * so a document cannot name another plugin's geometry.
 */
export type ShapeTable = Readonly<Record<string, ShapeContribution>>

/** What a decoration is told about the node it marks. */
export interface DecorationContext {
  readonly bounds: BoundingBox
  readonly label: Appearance
}

/** A plugin's mark on a node. Returns scene nodes in the shared vocabulary —
 *  the union stays closed, contributions build from it. */
export type NodeDecoration = (node: SpatialNode, context: DecorationContext) => readonly SceneNode[]

/**
 * Everything one plugin contributes to rendering.
 *
 * `shapes` are keyed by BARE name and `readShape` answers a bare kind: the
 * renderer composes `${namespace}.${kind}` at both ends, so a payload never
 * carries a namespace and a document cannot name another plugin's geometry
 * however it is written.
 *
 * A reader rather than a facet KEY, because reading a facet is the plugin's
 * job: the bundled one resolves through the engine's compat chain and schema,
 * which a raw `stored.kind` read of a declared key never did.
 */
export interface RenderContribution {
  readonly namespace: string
  readonly shapes?: Readonly<Record<string, ShapeContribution>>
  readonly readShape?: (node: SpatialNode) => string | undefined
  readonly readTextPlacement?: (node: SpatialNode) => 'start' | 'center' | undefined
  readonly decorations?: readonly NodeDecoration[]
  /**
   * Theme assets by BARE name, namespaced to `${namespace}.${name}` the way
   * `shapes` are. Unlike a shape, a theme id in a document MAY name another
   * contribution's asset (ADR-0030 decision 2): reuse across plugins is what
   * an asset is for, so the table is looked up by full id.
   */
  readonly themes?: Readonly<Record<string, ThemeTokens>>
  /** The theme id the CANVAS names (its own facet), or undefined for none. */
  readonly readTheme?: (canvas: SpatialCanvas) => string | undefined
}
