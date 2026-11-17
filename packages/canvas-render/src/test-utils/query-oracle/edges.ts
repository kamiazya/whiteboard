import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { EdgeAnchorOverride } from '../../edge-routing.js'
import type { EditorProfile } from './boards.js'

/**
 * The recorded answers of `layoutSpatialEdges`, the edge-only layout the
 * editor's drag layers run on every pointer move (ADR-0054 step 7, S18a):
 * each corpus board with its first edge-touching box moved a few steps, under
 * the drag layers' options and the side overrides they hand — every edge the
 * gesture does not carry held where the committed layout drew it, and the
 * carried edges either re-sided (`fresh`) or held at their sides (`cached`).
 *
 * A record holds the moved canvas and the overrides as JSON reads them back,
 * and the edge layer as `scene_wire` writes it.
 */

interface EdgesInput {
  readonly id: string
  readonly canvas: SpatialCanvas
  readonly profile: EditorProfile
  readonly overrides: readonly (readonly [string, EdgeAnchorOverride])[]
}

export interface EdgesRecord extends EdgesInput {
  readonly answer: string
}
