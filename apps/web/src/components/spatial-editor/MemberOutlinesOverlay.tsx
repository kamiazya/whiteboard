import type { CanvasEdge } from '@kamiazya/whiteboard-model'
import { endIn } from '@kamiazya/whiteboard-model'
/**
 * Which nodes are in the selection. The selection overlay outlines the
 * region the handles act on, which says nothing about membership —
 * outlining only the extras left the primary looking untouched, so a
 * Select All over three nodes read as though it had skipped one.
 */
import type { NodeBox } from '../../lib/spatial/geometry.js'
import type { Point } from '../../lib/spatial/viewport.js'

export interface MemberOutlinesOverlayProps {
  readonly selectionMembers: readonly NodeBox[]
  /** Read only to find edges inside the members, so unused once `outlinedEdgeIds` names them. */
  readonly edges?: readonly Pick<CanvasEdge, 'id' | 'from' | 'to'>[]
  readonly edgePaths: readonly { readonly id: string; readonly path: readonly Point[] }[]
  readonly zoom: number
  /**
   * Outline colour. Defaults to the manipulation accent, which is what a
   * SELECTION means. An agent's recent edit reuses this overlay with a
   * different colour, because "these boxes, outlined" is the same drawing —
   * only what it means differs.
   */
  readonly stroke?: string
  readonly testId?: string
  /**
   * Outline exactly these edges, whatever their ends. Without it an edge is
   * outlined only when BOTH ends are members, which is what a selection's
   * area actions follow; an agent's edit can reach an edge alone. The ids
   * are looked up in `edgePaths`, so a stroke (which routes beside the edges
   * but is not one) is named the same way.
   */
  readonly outlinedEdgeIds?: ReadonlySet<string>
}

/** The ids the outline marks: the named ones, else the edges inside the members. */
function outlinedEdgeIdsOf(
  edges: MemberOutlinesOverlayProps['edges'],
  members: readonly NodeBox[],
  named: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  if (named !== undefined) return named
  const memberIds = new Set(members.map((member) => member.id))
  return new Set(
    (edges ?? [])
      .filter((edge) => endIn(edge.from, memberIds) && endIn(edge.to, memberIds))
      .map((edge) => edge.id),
  )
}

export function MemberOutlinesOverlay({
  selectionMembers,
  edges,
  edgePaths,
  zoom,
  stroke = 'var(--manipulation)',
  testId = 'member-outlines',
  outlinedEdgeIds,
}: MemberOutlinesOverlayProps) {
  const marked = outlinedEdgeIdsOf(edges, selectionMembers, outlinedEdgeIds)
  return (
    <svg
      data-testid={testId}
      aria-hidden="true"
      style={{
        position: 'absolute',
        overflow: 'visible',
        left: 0,
        top: 0,
        pointerEvents: 'none',
      }}
    >
      {/* Edges INSIDE the area (both endpoints are members) follow
        area actions like recolor, so the highlight marks them along
        with the member boxes — an edge leaving the area does not
        follow and stays unmarked. */}
      {edgePaths
        .filter((entry) => marked.has(entry.id))
        .map(({ id, path }) => (
          <polyline
            key={`edge-${id}`}
            data-edge-id={id}
            points={path.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke={stroke}
            strokeWidth={2.5 / zoom}
            strokeLinecap="round"
            opacity={0.5}
          />
        ))}
      {selectionMembers.map(({ id, box }) => (
        <rect
          key={id}
          x={box.x}
          y={box.y}
          width={box.width}
          height={box.height}
          fill="none"
          stroke={stroke}
          strokeWidth={1.5 / zoom}
          opacity={0.7}
        />
      ))}
    </svg>
  )
}
