import type { Point } from '../../lib/spatial/viewport.js'

/**
 * The stroke under the pen, drawn from the samples the gesture machine is
 * accumulating — the same list the release will turn into a line, so what
 * the hand sees and what gets written cannot disagree.
 *
 * Canvas space, like every other overlay here, so it rides the pan/zoom
 * transform. The width divides by zoom to keep its on-screen weight, and the
 * ink is the board's own `edgeStroke`: a draft that committed to a different
 * colour would flicker at the release on any themed board.
 */
export function InkDraftLayer({
  points,
  zoom,
  stroke,
  weight = 1,
}: {
  points: readonly Point[]
  zoom: number
  stroke: string
  /**
   * The drawn stroke's multiple of the line weight, in canvas units. The
   * draft never goes thinner than two screen pixels, so a thin pen stays
   * visible under the hand at any zoom, and grows with the heavier weights.
   */
  weight?: number
}) {
  if (points.length < 2) return null
  return (
    <svg
      data-testid="ink-draft"
      aria-hidden="true"
      style={{
        position: 'absolute',
        overflow: 'visible',
        left: 0,
        top: 0,
        pointerEvents: 'none',
      }}
    >
      <polyline
        points={points.map((point) => `${point.x},${point.y}`).join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth={Math.max(2 / zoom, weight)}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
