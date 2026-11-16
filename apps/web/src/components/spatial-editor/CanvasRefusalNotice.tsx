import { type LayoutRefusal, refusalCopy, type Scene } from '@kamiazya/whiteboard-canvas-render'

/**
 * A board the layout refused (ADR-0054 step 7, owner decision q81), said in
 * SCREEN space: centred in the editor, apart from the pan/zoom transform, so
 * the words stay clear of the shortcuts button in the top-left corner, the
 * dock along the bottom and the minimap in the bottom-right wherever the board
 * sits and at any zoom. Every other surface draws the same words as the
 * scene's own notice; the editor draws them here instead, since in canvas
 * space they would move under its chrome.
 *
 * `pointer-events-none`, like the empty-canvas cue: it must never take a press
 * the canvas would have had.
 */
export function CanvasRefusalNotice({ refusal }: { readonly refusal: LayoutRefusal | undefined }) {
  if (refusal === undefined) return null
  const { title, detail } = refusalCopy(refusal)
  return (
    <div
      role="status"
      data-testid="canvas-refusal-notice"
      className="pointer-events-none absolute inset-x-6 top-1/2 mx-auto max-w-120 -translate-y-1/2 rounded-md border bg-muted px-4 py-3 text-sm text-foreground shadow-sm select-none"
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-muted-foreground">{detail}</p>
    </div>
  )
}

/** What canvas space draws while the notice says why nothing is. */
const NOTHING_DRAWN: Scene = { nodes: [] }

/** The scene the editor draws in canvas space: none for a refused layout, whose notice is said above it. */
export function drawnScene(laidOut: Scene): Scene {
  return laidOut.refusal === undefined ? laidOut : NOTHING_DRAWN
}
