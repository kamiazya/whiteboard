/**
 * Which nodes are in the selection. The selection overlay outlines the
 * region the handles act on, which says nothing about membership —
 * outlining only the extras left the primary looking untouched, so a
 * Select All over three nodes read as though it had skipped one.
 */
import type { Box } from './geometry.js'
import type { Point } from './viewport.js'

interface RoutedEdgePath {
  readonly id: string
  readonly path: readonly Point[]
}

export interface MemberOutlinesOverlayProps {
  readonly selectionMembers: readonly { readonly id: string; readonly box: Box }[]
  readonly edges: readonly {
    readonly id: string
    readonly fromNode: string
    readonly toNode: string
  }[]
  readonly edgePaths: readonly RoutedEdgePath[]
  readonly zoom: number
}

export function MemberOutlinesOverlay({
  selectionMembers,
  edges,
  edgePaths,
  zoom,
}: MemberOutlinesOverlayProps) {
  return (
    <svg
      data-testid="member-outlines"
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
      {(() => {
        const memberIds = new Set(selectionMembers.map((member) => member.id))
        return edges
          .filter((edge) => memberIds.has(edge.fromNode) && memberIds.has(edge.toNode))
          .flatMap((edge) => {
            const routed = edgePaths.find((entry) => entry.id === edge.id)
            return routed === undefined ? [] : [{ id: edge.id, path: routed.path }]
          })
          .map(({ id, path }) => (
            <polyline
              key={`edge-${id}`}
              data-edge-id={id}
              points={path.map((p) => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke="#2563eb"
              strokeWidth={2.5 / zoom}
              strokeLinecap="round"
              opacity={0.5}
            />
          ))
      })()}
      {selectionMembers.map(({ id, box }) => (
        <rect
          key={id}
          x={box.x}
          y={box.y}
          width={box.width}
          height={box.height}
          fill="none"
          stroke="#2563eb"
          strokeWidth={1.5 / zoom}
          opacity={0.7}
        />
      ))}
    </svg>
  )
}
