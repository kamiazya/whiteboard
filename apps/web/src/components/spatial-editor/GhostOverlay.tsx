/**
 * The pending-cut veil: a cut is the front half of a move, so its nodes
 * stay in the document and are dimmed here instead of deleted. Pure view
 * state — never persisted, never synced; a reload resolves to "nothing was
 * deleted", which is the safe default. Drawn in canvas space under the
 * viewport transform, like the other selection overlays. The veil paints
 * the theme background at 55% so both themes dim correctly, and the dashed
 * outline is deliberately STATIC — a marching-ants loop would break the
 * draw-once motion grammar.
 */
export interface GhostBox {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface GhostOverlayProps {
  readonly boxes: readonly GhostBox[]
  readonly zoom: number
}

export function GhostOverlay({ boxes, zoom }: GhostOverlayProps) {
  return (
    <svg
      data-testid="ghost-overlay"
      aria-hidden="true"
      style={{
        position: 'absolute',
        overflow: 'visible',
        left: 0,
        top: 0,
        pointerEvents: 'none',
      }}
    >
      {boxes.map((box) => (
        <g key={box.id}>
          <rect
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            rx={6 / zoom}
            fill="var(--background)"
            opacity={0.55}
          />
          <rect
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            rx={6 / zoom}
            fill="none"
            stroke="var(--manipulation)"
            strokeWidth={1.5 / zoom}
            strokeDasharray={`${6 / zoom} ${4 / zoom}`}
          />
        </g>
      ))}
    </svg>
  )
}
