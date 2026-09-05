import type { Point } from '../../lib/spatial/viewport.js'

/**
 * The selected connection, re-drawn thicker over the committed ink. The
 * path is the DRAWN (flattened) line the hit-test already resolved, so the
 * highlight lands exactly on what a tap selected. Renders nothing when the
 * selected edge is no longer laid out (deleted under the selection) or too
 * short to draw.
 */
export function EdgeSelectionHighlight({
  selectedEdgeId,
  edgePaths,
}: {
  selectedEdgeId: string
  edgePaths: readonly { readonly id: string; readonly path: readonly Point[] }[]
}) {
  const selected = edgePaths.find((edge) => edge.id === selectedEdgeId)
  if (selected === undefined || selected.path.length < 2) return null
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
      <polyline
        data-testid="edge-selection-highlight"
        points={selected.path.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke="var(--manipulation)"
        strokeWidth={3}
        strokeLinecap="round"
      />
    </svg>
  )
}
