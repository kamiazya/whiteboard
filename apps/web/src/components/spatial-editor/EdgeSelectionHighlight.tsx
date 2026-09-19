import type { Point } from '../../lib/spatial/viewport.js'

/**
 * The selected connections, re-drawn thicker over the committed ink. Each
 * path is the DRAWN (flattened) line the hit-test already resolved, so a
 * highlight lands exactly on what a tap — or a band — selected. Ids that are
 * no longer laid out (deleted under the selection) or too short to draw
 * contribute nothing.
 */
export function EdgeSelectionHighlight({
  selectedEdgeIds,
  edgePaths,
}: {
  selectedEdgeIds: readonly string[]
  edgePaths: readonly { readonly id: string; readonly path: readonly Point[] }[]
}) {
  const selected = edgePaths.filter(
    (edge) => selectedEdgeIds.includes(edge.id) && edge.path.length >= 2,
  )
  if (selected.length === 0) return null
  return (
    <svg
      style={{
        position: 'absolute',
        overflow: 'visible',
        left: 0,
        top: 0,
        pointerEvents: 'none',
      }}
    >
      <title>Selected connection</title>
      {selected.map((edge) => (
        <polyline
          key={edge.id}
          data-testid="edge-selection-highlight"
          points={edge.path.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke="var(--manipulation)"
          strokeWidth={3}
          strokeLinecap="round"
        />
      ))}
    </svg>
  )
}
