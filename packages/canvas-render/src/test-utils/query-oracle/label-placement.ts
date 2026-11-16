import type { SpatialNode } from '@kamiazya/whiteboard-model'
import type { SceneNode } from '@kamiazya/whiteboard-scene'

/**
 * The recorded answers of where an edge's label goes (ADR-0054 step 7,
 * S18a): `edgeLabelPlacement` over every edge the corpus boards draw, at the
 * size of the editor's inline label editor and of a short and a long label,
 * along the drawn path and along its rounded flattening, with the obstacles
 * the editor hands it — `labelObstacles` of the canvas's boxes plus
 * `frameTitleObstacles` of the committed scene's frame titles, both recorded
 * as their own answers too — and hand-written paths: degenerate ones, a
 * crowd the label has to slide out of, and one it cannot leave.
 *
 * Every double is the hex of its bits; an absent placement is `null`.
 */

type Hex = readonly string[]

export type LabelPlacementRecord =
  | {
      readonly kind: 'place'
      readonly id: string
      readonly path: readonly Hex[]
      readonly size: Hex
      readonly obstacles: readonly Hex[]
      readonly rounded: boolean
      readonly answer: Hex | null
    }
  | {
      readonly kind: 'obstacles'
      readonly id: string
      readonly nodes: readonly SpatialNode[]
      /** The committed scene's text runs that annotate an element, which is what `frameTitleObstacles` reads. */
      readonly runs: readonly SceneNode[]
      readonly titles: readonly Hex[]
      readonly answer: readonly Hex[]
    }
