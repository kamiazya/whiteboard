/** Hand mode's dock leading slot: view-only zoom controls (in/out/reset/fit). */
import { Focus, ZoomIn, ZoomOut } from 'lucide-react'
import { DOCK_WIDE_BUTTON_CLASS } from '@/components/ui/dock-button'
import { TOOL_BUTTON_CLASS } from './ToolPalette.js'

/** Wheel/pinch step multiplier per zoom-in/out button press. */
const ZOOM_STEP_FACTOR = 1.25

export interface HandViewControlsProps {
  readonly zoom: number
  readonly onZoom: (factor: number) => void
  readonly onZoomToFit: () => void
}

export function HandViewControls({ zoom, onZoom, onZoomToFit }: HandViewControlsProps) {
  return (
    <>
      <button
        type="button"
        data-testid="zoom-out-button"
        aria-label="Zoom out"
        onClick={() => onZoom(1 / ZOOM_STEP_FACTOR)}
        className={TOOL_BUTTON_CLASS}
      >
        <ZoomOut aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        data-testid="zoom-reset-button"
        aria-label="Reset zoom to 100%"
        onClick={() => onZoom(1 / zoom)}
        className={`${DOCK_WIDE_BUTTON_CLASS} text-xs tabular-nums`}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        type="button"
        data-testid="zoom-in-button"
        aria-label="Zoom in"
        onClick={() => onZoom(ZOOM_STEP_FACTOR)}
        className={TOOL_BUTTON_CLASS}
      >
        <ZoomIn aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        data-testid="zoom-fit-button"
        aria-label="Zoom to fit"
        onClick={() => {
          onZoomToFit()
        }}
        className={TOOL_BUTTON_CLASS}
      >
        <Focus aria-hidden="true" className="size-4" />
      </button>
    </>
  )
}
