/**
 * The contract between the renderer and every plugin: what a plugin
 * contributes to drawing a canvas, and the geometry vocabulary those
 * contributions speak.
 *
 * It lives BELOW both, and that is the whole point. Inside the renderer, a
 * plugin importing it would close a package cycle — held open only by the import being type-only, a property no manifest can
 * see and only a hand-written guard could check. A contract is not the
 * renderer's private type; it belongs where both sides can reach it without
 * reaching for each other.
 */
import type { ThemeTokens } from '@kamiazya/whiteboard-facet-engine'
import type { CanvasEdge, CanvasLine, SpatialCanvas } from '@kamiazya/whiteboard-model'

/**
 * What the router and an appearance resolver are handed: an EDGE or a LINE
 * ([ADR-0038](../../../docs/contributing/adr/0038-ocif-projection.md)
 * decision 2). The two differ in what they MEAN and in the shape of an end,
 * never in how a route between two places is found, so both are routed and
 * painted alike — and code that only understands relations narrows on
 * `'kind' in end` rather than being handed a narrower type it cannot ask
 * about.
 */
export type RoutableElement = CanvasEdge | CanvasLine

import type { BoundingBox } from './scene-graph.js'

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
 * `outline` is the whole contract for painting a silhouette. Hit-testing and
 * edge anchoring are the Rust core's, over its port of the same geometry
 * (held to `node-outline.jsonl`); its containment test switches on the
 * returned VALUE's kind and its entry-point search bisects against that, so
 * one implementation serves every shape. A contributed shape the core has no
 * port of is drawn here and hit-tested as its box.
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
}

/**
 * Shapes by namespaced id (`visual.diamond`). The namespace is COMPOSED by
 * the renderer from the declaring facet's key, never read out of a payload —
 * so a document cannot name another plugin's geometry.
 */
export type ShapeTable = Readonly<Record<string, ShapeContribution>>

/**
 * What one plugin registers with the renderer: its silhouettes and its theme
 * assets, and how it reads the theme a canvas names.
 *
 * The layout itself is the Rust core's, which reads a node's shape, text
 * placement and decorations through the plugin's own Rust twin
 * (`whiteboard-plugin-visual`). What is left here is what TypeScript still
 * draws or resolves: the SVG backend paints a silhouette from `shapes`, and
 * an editor chrome or an export previews the palette `themes` and
 * `readTheme` resolve to.
 *
 * `shapes` are keyed by BARE name: the renderer composes
 * `${namespace}.${name}`, so a payload never carries a namespace and a
 * document cannot name another plugin's geometry however it is written.
 */
export interface RenderContribution {
  readonly namespace: string
  readonly shapes?: Readonly<Record<string, ShapeContribution>>
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
