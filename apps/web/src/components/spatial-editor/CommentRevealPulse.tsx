/**
 * A ring on what a revealed conversation is about. In SCREEN coordinates,
 * like the cards, so its stroke keeps a screen size whatever the zoom.
 */
import { canvasToScreen, type Viewport } from '../../lib/spatial/viewport.js'
import type { RevealPulse } from './use-comment-reveal.js'

/** Air around the anchor so the ring does not sit on the node's own border. */
const RING_GAP_PX = 4

export function CommentRevealPulse({
  pulse,
  viewport,
  color,
}: {
  readonly pulse: RevealPulse
  readonly viewport: Viewport
  readonly color: string
}) {
  const at = canvasToScreen({ x: pulse.box.x, y: pulse.box.y }, viewport)
  return (
    <div
      key={pulse.key}
      data-testid="comment-reveal-pulse"
      aria-hidden="true"
      className="pointer-events-none absolute z-10 rounded-md motion-safe:animate-pulse"
      style={{
        left: at.x - RING_GAP_PX,
        top: at.y - RING_GAP_PX,
        width: pulse.box.width * viewport.zoom + 2 * RING_GAP_PX,
        height: pulse.box.height * viewport.zoom + 2 * RING_GAP_PX,
        border: `2px solid ${color}`,
        boxShadow: `0 0 0 4px ${color}33`,
      }}
    />
  )
}
