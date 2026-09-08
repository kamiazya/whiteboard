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
import type { VisualSymbolFacet } from '@kamiazya/whiteboard-plugin-visual'
import { canDrawSymbol, SymbolMark } from '@kamiazya/whiteboard-plugin-visual/ui'
import {
  fitMinimap,
  type MinimapBox,
  projectBox,
  unprojectPoint,
} from '../../lib/spatial/minimap.js'

const PADDING_PX = 6

/**
 * The shortest side a box must project to before a mark is drawn in it.
 *
 * Measured rather than chosen: on a real canvas of eight ordinary notes the
 * overview projects each one to 21x11px, which puts the glyph at ~9px — too
 * small to recognise, and 11 sat right ON an earlier 10px guess, where an
 * ordinary edit rescales the fit and flips every mark on and off. 14 puts
 * the glyph at ~11px, about the floor for an emoji to read, and lands
 * clearly above the ordinary case rather than inside it.
 *
 * The consequence is deliberate and worth knowing: a busy canvas shows no
 * marks in its overview, and a canvas of a few large nodes does. A mark
 * appears when there is room to read one, which is the only condition under
 * which it is worth anything.
 */
const SYMBOL_MIN_PX = 14

/**
 * A node in the overview: its box, an already-resolved CSS colour, and the
 * node's own symbol when it declares one.
 */
export type MinimapNode = MinimapBox & {
  readonly color?: string
  readonly symbol?: VisualSymbolFacet
}

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
      // z-10 matches the dock. Without a stacking context of its own the
      // scene paints over the overview — it is later in the DOM and its
      // nodes are positioned, so document order wins.
      // Safe-area offsets for the same reason the dock carries one: in
      // fullscreen this corner is the screen corner, under the home
      // indicator and — rotated — under the display cutout.
      className="absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] right-[calc(1rem+env(safe-area-inset-right))] z-10 overflow-hidden rounded-md border bg-background/80 shadow-sm"
      onPointerDown={navigateTo}
      onPointerMove={(event) => {
        // Only while the button is held — a pointer merely passing over the
        // overview must not move the canvas.
        if (event.buttons === 1) navigateTo(event)
      }}
    >
      {boxes.map((box, index) => {
        const projected = projectBox(box, fit)
        const width = Math.max(1, projected.width)
        const height = Math.max(1, projected.height)
        // The mark sits IN the box rather than replacing it: the overview's
        // job is the arrangement, and a symbol adds which node this one is
        // without taking away where it sits. Below the threshold the box
        // keeps its plain fill — the same judgement the node badge makes at
        // full size, asked again at this scale.
        const marked =
          box.symbol !== undefined &&
          canDrawSymbol(box.symbol) &&
          Math.min(width, height) >= SYMBOL_MIN_PX
        return (
          <div
            // Boxes arrive in document order and carry no id of their own
            // here; position disambiguates within one render.
            key={`${index}:${box.x},${box.y}`}
            // An authored colour is the fastest way to find a node in an
            // overview too small to read labels in; an unstyled node keeps
            // the muted default rather than inventing an accent for it.
            className={
              box.color === undefined
                ? 'absolute flex items-center justify-center overflow-hidden bg-muted-foreground/40'
                : 'absolute flex items-center justify-center overflow-hidden'
            }
            style={{
              background: box.color,
              left: projected.x,
              top: projected.y,
              // A node thinner than a pixel at this scale still has to be
              // visible — an overview that drops content is worse than none.
              width,
              height,
            }}
          >
            {marked && box.symbol !== undefined ? (
              <span
                data-testid="minimap-symbol"
                className="leading-none"
                style={{ fontSize: Math.min(width, height) * 0.8, width: '0.8em', height: '0.8em' }}
              >
                <SymbolMark symbol={box.symbol} />
              </span>
            ) : null}
          </div>
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
