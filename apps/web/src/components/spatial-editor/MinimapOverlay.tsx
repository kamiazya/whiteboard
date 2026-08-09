/**
 * A corner overview of the whole canvas, with a marker for the visible area.
 *
 * Read-only except for one gesture: pressing (or dragging) centres the real
 * viewport on the point you pointed at. That is the entire interaction budget
 * on purpose — an overview that also selected, or panned on hover, would
 * compete with the canvas underneath it for the same pointer.
 *
 * Built from positioned divs rather than an `<svg>`, which is not a style
 * preference: the editor's own scene is an SVG in the same container, and
 * tests (and any future consumer) reach for it with `container.querySelector('svg')`
 * and `querySelectorAll('svg rect')`. A second SVG here would silently join
 * those queries and answer for the scene. Rectangles need no SVG anyway.
 */
import { fitMinimap, type MinimapBox, projectBox, unprojectPoint } from './minimap.js'

const PADDING_PX = 6

/** A node in the overview: its box plus an already-resolved CSS colour. */
export type MinimapNode = MinimapBox & { readonly color?: string }

export interface MinimapOverlayProps {
  /**
   * Every node's canvas-space box. Colour is resolved by the caller, not
   * here: this component knows nothing about palettes or theme mode, the
   * same way the fitting geometry knows nothing about the DOM.
   */
  readonly boxes: readonly MinimapNode[]
  /** The canvas-space rect currently visible in the editor. */
  readonly viewportRect: MinimapBox
  readonly width: number
  readonly height: number
  /** Called with the canvas-space point the viewport should centre on. */
  readonly onNavigate: (point: { x: number; y: number }) => void
}

export function MinimapOverlay({
  boxes,
  viewportRect,
  width,
  height,
  onNavigate,
}: MinimapOverlayProps) {
  const fit = fitMinimap(boxes, viewportRect, { width, height }, PADDING_PX)
  const marker = projectBox(viewportRect, fit)

  const navigateTo = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    onNavigate(unprojectPoint({ x: event.clientX - rect.left, y: event.clientY - rect.top }, fit))
  }

  return (
    // Not a <button>: the target is a POSITION, not an action, so the useful
    // keyboard affordance is the editor's own pan/zoom, not tabbing to a
    // control whose activation point no keypress can express. Hidden from
    // assistive tech for the same reason — it duplicates the canvas.
    <div
      // The editor root treats a press anywhere outside an opted-in overlay
      // as canvas: without this, pressing the minimap ALSO starts a marquee
      // in Select mode or a pan in Hand mode, underneath the navigation it
      // was meant to perform.
      data-editor-overlay
      data-testid="minimap"
      aria-hidden="true"
      style={{ width, height }}
      className="absolute bottom-4 right-4 overflow-hidden rounded-md border bg-background/80 shadow-sm"
      onPointerDown={navigateTo}
      onPointerMove={(event) => {
        // Only while the button is held — a pointer merely passing over the
        // overview must not move the canvas.
        if (event.buttons === 1) navigateTo(event)
      }}
    >
      {boxes.map((box, index) => {
        const projected = projectBox(box, fit)
        return (
          <div
            // Boxes arrive in document order and carry no id of their own
            // here; position disambiguates within one render.
            key={`${index}:${box.x},${box.y}`}
            // An authored colour is the fastest way to find a node in an
            // overview too small to read labels in; an unstyled node keeps
            // the muted default rather than inventing an accent for it.
            className={box.color === undefined ? 'absolute bg-muted-foreground/40' : 'absolute'}
            style={{
              background: box.color,
              left: projected.x,
              top: projected.y,
              // A node thinner than a pixel at this scale still has to be
              // visible — an overview that drops content is worse than none.
              width: Math.max(1, projected.width),
              height: Math.max(1, projected.height),
            }}
          />
        )
      })}
      <div
        data-testid="minimap-viewport"
        className="absolute border border-primary"
        style={{
          left: marker.x,
          top: marker.y,
          width: Math.max(1, marker.width),
          height: Math.max(1, marker.height),
        }}
      />
    </div>
  )
}
