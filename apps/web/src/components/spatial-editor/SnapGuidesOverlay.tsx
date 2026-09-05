import { useMemo } from 'react'
import type { NodeBox } from '../../lib/spatial/geometry.js'

/**
 * The rulers justifying the current snap, in canvas space. Dashed with a
 * dot at each end: a ruler showing a measured extent, not an alert line.
 * The dash and dot sizes divide by zoom for the same reason every handle
 * does — the ruler is chrome, and chrome keeps its on-screen size.
 */
export function SnapGuidesOverlay({
  guides,
  boxes,
  zoom,
}: {
  guides: { readonly x: readonly number[]; readonly y: readonly number[] }
  boxes: readonly NodeBox[]
  zoom: number
}) {
  /**
   * How far a snap guide extends, in canvas space: across all content plus
   * a margin. Spanning the content rather than the window keeps the line a
   * function of the document alone, so it renders identically at any zoom
   * or scroll position and needs no measured element size.
   */
  const guideSpan = useMemo(() => {
    const GUIDE_MARGIN_PX = 40
    if (boxes.length === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
    const xs = boxes.flatMap((entry) => [entry.box.x, entry.box.x + entry.box.width])
    const ys = boxes.flatMap((entry) => [entry.box.y, entry.box.y + entry.box.height])
    return {
      minX: Math.min(...xs) - GUIDE_MARGIN_PX,
      maxX: Math.max(...xs) + GUIDE_MARGIN_PX,
      minY: Math.min(...ys) - GUIDE_MARGIN_PX,
      maxY: Math.max(...ys) + GUIDE_MARGIN_PX,
    }
  }, [boxes])

  if (guides.x.length + guides.y.length === 0) return null
  return (
    <svg
      data-testid="snap-guides"
      aria-hidden="true"
      style={{
        position: 'absolute',
        overflow: 'visible',
        left: 0,
        top: 0,
        pointerEvents: 'none',
      }}
    >
      {guides.x.map((x) => (
        <g key={`x${x}`}>
          <line
            data-axis="x"
            x1={x}
            x2={x}
            y1={guideSpan.minY}
            y2={guideSpan.maxY}
            stroke="var(--manipulation-guide)"
            strokeWidth={1 / zoom}
            strokeDasharray={`${4 / zoom} ${3 / zoom}`}
          />
          <circle cx={x} cy={guideSpan.minY} r={2 / zoom} fill="var(--manipulation-guide)" />
          <circle cx={x} cy={guideSpan.maxY} r={2 / zoom} fill="var(--manipulation-guide)" />
        </g>
      ))}
      {guides.y.map((y) => (
        <g key={`y${y}`}>
          <line
            data-axis="y"
            x1={guideSpan.minX}
            x2={guideSpan.maxX}
            y1={y}
            y2={y}
            stroke="var(--manipulation-guide)"
            strokeWidth={1 / zoom}
            strokeDasharray={`${4 / zoom} ${3 / zoom}`}
          />
          <circle cx={guideSpan.minX} cy={y} r={2 / zoom} fill="var(--manipulation-guide)" />
          <circle cx={guideSpan.maxX} cy={y} r={2 / zoom} fill="var(--manipulation-guide)" />
        </g>
      ))}
    </svg>
  )
}
