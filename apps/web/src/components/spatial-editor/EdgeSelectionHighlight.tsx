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
  offset,
}: {
  selectedEdgeIds: readonly string[]
  edgePaths: readonly { readonly id: string; readonly path: readonly Point[] }[]
  /**
   * Where the selection is being dragged to, while it is. Absent at rest.
   * A transform rather than re-derived points: the paths are the DRAWN ones
   * and a translation of ink is a translation of its ink, so the browser
   * can do it per frame for nothing.
   */
  offset?: { readonly x: number; readonly y: number }
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
      <g transform={offset === undefined ? undefined : `translate(${offset.x} ${offset.y})`}>
        {/* ONE element for the whole selection, each stroke a subpath. A
          keyed list of <polyline>s is the obvious shape and was tried: in
          the editor's tree (not in isolation) it tripped React's
          "`key` is not a prop" warning, which the browser setup turns into a
          failure. One element also keeps `data-testid` unique, which strict
          locators require. */}
        <path
          data-testid="edge-selection-highlight"
          d={selected
            .map((edge) => `M ${edge.path.map((point) => `${point.x} ${point.y}`).join(' L ')}`)
            .join(' ')}
          fill="none"
          stroke="var(--manipulation)"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  )
}
