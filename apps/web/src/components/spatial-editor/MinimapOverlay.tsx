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
import { Map as MapIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { readMinimapOpen, writeMinimapOpen } from '../../lib/minimap-visibility.js'
import {
  fitMinimap,
  type MinimapBox,
  projectBox,
  unprojectPoint,
} from '../../lib/spatial/minimap.js'
import { cn } from '../../lib/utils.js'
import { DOCK_BUTTON_CLASS, TOGGLE_STATE_CLASS } from '../ui/dock-button.js'
import { keyboardAvoidanceSubject } from './use-keyboard-avoidance.js'

const PADDING_PX = 6

/**
 * The mark's own size, in pixels, whatever box it lands in.
 *
 * ONE size, the same rule the full-size badge follows on a node of any area.
 * Scaling it with the box was measured in one overview at 20.9px and 31.4px,
 * which reads as a ranking of node areas rather than as identity — and the
 * threshold below already assumed a fixed glyph, so the two had drifted: its
 * reasoning is written for ~11px and the code drew 26 and 39.
 *
 * 11 is the floor for an emoji to read, and it is what the smallest box this
 * draws in can hold with its own fill still visible around it.
 */
const SYMBOL_PX = 11

/**
 * The shortest side a box must project to before a mark is drawn in it.
 *
 * Measured rather than chosen: on a real canvas of eight ordinary notes the
 * overview projects each one to 21x11px, which puts an 11px glyph over the
 * whole box — and 11 sat right ON an earlier 10px guess, where an ordinary
 * edit rescales the fit and flips every mark on and off. 14 holds
 * `SYMBOL_PX` with a rim of box left, and lands clearly above the ordinary
 * case rather than inside it.
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
type MinimapNode = MinimapBox & {
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
  /**
   * The editor is too narrow to hold the overview beside the dock, so it sits
   * behind a corner button above the dock and starts hidden.
   */
  readonly collapsible?: boolean
}

/** Clears the dock (its height plus the bottom offset) with a gap. */
const TOGGLE_BOTTOM = 'bottom-[calc(5rem+env(safe-area-inset-bottom))]'
const RAISED_BOTTOM = 'bottom-[calc(8.5rem+env(safe-area-inset-bottom))]'

/**
 * Whether a text entry inside the surrounding editor root has focus. The
 * overview shares the bottom-right corner with the formatting bar and the
 * on-screen keyboard's strip, so while someone types it can only cover the
 * thing being typed into or sit clipped behind the bar; it returns when the
 * entry loses focus. `anchor` is a childless marker inside that root — the
 * overlay has no element of its own to ask.
 */
function useTextEntryFocused(anchor: React.RefObject<HTMLElement | null>): boolean {
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    const root = anchor.current?.parentElement
    if (root === null || root === undefined) return
    const refresh = () => setFocused(keyboardAvoidanceSubject(root) !== null)
    document.addEventListener('focusin', refresh)
    document.addEventListener('focusout', refresh)
    refresh()
    return () => {
      document.removeEventListener('focusin', refresh)
      document.removeEventListener('focusout', refresh)
    }
  }, [anchor])
  return focused
}

export function MinimapOverlay({ collapsible = false, ...props }: MinimapOverlayProps) {
  const [open, setOpen] = useState(readMinimapOpen)
  const anchor = useRef<HTMLSpanElement>(null)
  const typing = useTextEntryFocused(anchor)
  const marker = <span ref={anchor} hidden />
  if (typing) return <>{marker}</>
  if (!collapsible) {
    return (
      <>
        {marker}
        <MinimapSurface {...props} />
      </>
    )
  }
  return (
    <>
      {marker}
      <div
        data-editor-overlay
        data-testid="minimap-toggle-wrap"
        className={cn(
          'absolute right-[calc(0.75rem+env(safe-area-inset-right))] z-10 rounded-lg border bg-background p-0.5 shadow-md',
          TOGGLE_BOTTOM,
        )}
      >
        <button
          type="button"
          data-testid="minimap-toggle"
          aria-label={open ? 'Hide overview' : 'Show overview'}
          aria-expanded={open}
          onClick={() => {
            writeMinimapOpen(!open)
            setOpen(!open)
          }}
          className={`${DOCK_BUTTON_CLASS} ${TOGGLE_STATE_CLASS}`}
        >
          <MapIcon aria-hidden="true" className="size-4" />
        </button>
      </div>
      {open && <MinimapSurface {...props} raised />}
    </>
  )
}

function MinimapSurface({
  boxes,
  viewportRect,
  width,
  height,
  onNavigate,
  raised = false,
}: Omit<MinimapOverlayProps, 'collapsible'> & { readonly raised?: boolean }) {
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
      className={cn(
        'absolute right-[calc(1rem+env(safe-area-inset-right))] z-10 overflow-hidden rounded-md border bg-background/80 shadow-sm',
        raised ? RAISED_BOTTOM : 'bottom-[calc(1rem+env(safe-area-inset-bottom))]',
      )}
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
                // The span is the glyph's own size rather than a fraction of
                // it: an emoji is text at `fontSize` and a vendored icon is an
                // SVG with no intrinsic size that fills its box, so the two
                // only land at the same size when the box and the font agree.
                style={{ fontSize: SYMBOL_PX, width: SYMBOL_PX, height: SYMBOL_PX }}
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
