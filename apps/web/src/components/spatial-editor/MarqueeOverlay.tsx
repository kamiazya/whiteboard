import type { Point } from '../../lib/spatial/viewport.js'

/**
 * The in-flight marquee rectangle, in canvas space (rides the pan/zoom
 * transform with every other canvas-space overlay). Stroke width and dash
 * divide by zoom so the chrome keeps its on-screen size.
 */
export function MarqueeOverlay({
  marquee,
  zoom,
}: {
  marquee: { start: Point; current: Point }
  zoom: number
}) {
  return (
    <svg
      data-testid="marquee-rect"
      aria-hidden="true"
      style={{
        position: 'absolute',
        overflow: 'visible',
        left: 0,
        top: 0,
        pointerEvents: 'none',
      }}
    >
      <rect
        x={Math.min(marquee.start.x, marquee.current.x)}
        y={Math.min(marquee.start.y, marquee.current.y)}
        width={Math.abs(marquee.current.x - marquee.start.x)}
        height={Math.abs(marquee.current.y - marquee.start.y)}
        fill="var(--manipulation)"
        fillOpacity={0.08}
        stroke="var(--manipulation)"
        strokeWidth={1 / zoom}
        strokeDasharray={`${4 / zoom} ${3 / zoom}`}
      />
    </svg>
  )
}
