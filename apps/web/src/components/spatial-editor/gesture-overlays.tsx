import type { ComponentProps } from 'react'
import type { EditorTool } from '../../lib/editor-tool.js'
import type { NodeBox } from '../../lib/spatial/geometry.js'
import type { Point } from '../../lib/spatial/viewport.js'
import type { EditorGesture } from './editor-gesture.js'
import { GhostOverlay } from './GhostOverlay.js'
import { InkDraftLayer } from './InkDraftLayer.js'
import { LinkEmbedLayer } from './LinkEmbedLayer.js'
import { MarqueeOverlay } from './MarqueeOverlay.js'
import { MemberOutlinesOverlay } from './MemberOutlinesOverlay.js'
import { SnapGuidesOverlay } from './SnapGuidesOverlay.js'
import { EXPAND_MIN_H, EXPAND_MIN_W } from './use-file-seam-scene.js'

export interface GestureOverlaysProps {
  readonly gesture: EditorGesture
  readonly tool: EditorTool
  readonly marquee: ComponentProps<typeof MarqueeOverlay>['marquee'] | null
  readonly snapGuides: ComponentProps<typeof SnapGuidesOverlay>['guides'] | null
  readonly inkStroke: string
  readonly boxes: readonly NodeBox[]
  /** The nodes a pending cut holds, which stay drawn as ghosts until the paste. */
  readonly cutIds: { has(id: string): boolean } | undefined
  /** The selection's members when there is more than one, else `undefined`. */
  readonly members: readonly NodeBox[] | undefined
  readonly edgePaths: readonly { readonly id: string; readonly path: readonly Point[] }[]
  readonly agentTouchedNodeIds: ReadonlySet<string> | undefined
}

/**
 * What is drawn in canvas space ABOUT the gesture in progress and the
 * selection it acts on, over the committed scene: link embeds, the band, the
 * stroke being drawn, the snap guides, and the outlines that say which nodes
 * a cut, a selection or an agent reached.
 */
export function GestureOverlays(props: GestureOverlaysProps) {
  const { gesture, marquee, snapGuides } = props
  const { state, canvas, viewport } = gesture
  return (
    <>
      {/* Editor-only iframe embeds for link nodes (never in exports); the LOD
        gate mirrors the canvas-embed thresholds. */}
      <LinkEmbedLayer
        canvas={canvas}
        interactive={props.tool !== 'hand'}
        shouldOffer={(node) =>
          node.width * viewport.zoom >= EXPAND_MIN_W && node.height * viewport.zoom >= EXPAND_MIN_H
        }
      />
      {marquee !== null && <MarqueeOverlay marquee={marquee} zoom={viewport.zoom} />}
      {state.kind === 'drawing' && (
        <InkDraftLayer points={state.points} zoom={viewport.zoom} stroke={props.inkStroke} />
      )}
      {snapGuides !== null && (
        <SnapGuidesOverlay guides={snapGuides} boxes={props.boxes} zoom={viewport.zoom} />
      )}
      <ReachOutlines {...props} />
    </>
  )
}

/**
 * Which nodes are in the selection, a pending cut, or an agent's last batch.
 * The selection overlay outlines the REGION its handles act on, which says
 * nothing about membership — outlining only the extras left the primary
 * looking untouched. Member outlines hide while a move is in flight: every
 * member travels with the ghost, so outlines derived from the committed scene
 * would mark geometry no longer drawn there.
 */
function ReachOutlines({
  gesture,
  cutIds,
  members,
  edgePaths,
  boxes,
  agentTouchedNodeIds,
}: GestureOverlaysProps) {
  const { state, canvas, viewport } = gesture
  return (
    <>
      {cutIds !== undefined && (
        <GhostOverlay
          boxes={canvas.nodes.flatMap((n) =>
            cutIds.has(n.id)
              ? [{ id: n.id, x: n.x, y: n.y, width: n.width, height: n.height }]
              : [],
          )}
          zoom={viewport.zoom}
        />
      )}
      {members !== undefined && state.kind !== 'moving' && (
        <MemberOutlinesOverlay
          selectionMembers={members}
          edges={canvas.edges}
          edgePaths={edgePaths}
          zoom={viewport.zoom}
        />
      )}
      {/* The same drawing in another colour. `edges` is empty on purpose: an
        edge outline is far less legible than a box one, and the nodes are
        what actually moved. */}
      {agentTouchedNodeIds !== undefined && agentTouchedNodeIds.size > 0 && (
        <MemberOutlinesOverlay
          testId="agent-touch-outlines"
          stroke="var(--accent-foreground)"
          selectionMembers={boxes.filter((entry) => agentTouchedNodeIds.has(entry.id))}
          edges={[]}
          edgePaths={[]}
          zoom={viewport.zoom}
        />
      )}
    </>
  )
}
