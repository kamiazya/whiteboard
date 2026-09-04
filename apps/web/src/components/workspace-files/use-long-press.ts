import { type MouseEvent as ReactMouseEvent, type PointerEvent, useMemo, useRef } from 'react'

/** Matches the platform's own long-press feel (iOS/Android context menus). */
export const LONG_PRESS_MS = 500
/** A hold that drifts this far is a scroll, not a press. */
const MOVE_SLOP_PX = 8

/**
 * Container-level long-press → object menu, for lists of document cards.
 *
 * One hook per LIST, not per card: the cards are rendered inline in a map,
 * where a per-card hook cannot live, and a timer held in per-render state
 * would be lost to any re-render that happens mid-hold. The card is found
 * from the event target's closest `[data-doc-path]`, which each list
 * already has reason to stamp.
 *
 * Touch only (`pointerType === 'touch'`): a mouse held down is a drag or a
 * hesitation, and right-click already reaches the same menu. Android fires
 * a native `contextmenu` at roughly the same hold, which opens the same
 * menu through the card's existing handler — both paths land on the same
 * state, so racing is harmless.
 *
 * `onClickCapture` is the suppression: releasing a long-press still
 * dispatches a click, and with tap-to-open wired that click would OPEN the
 * document under the menu that just asked what to do with it.
 */
export function useLongPressMenu(
  onLongPress: ((path: string, x: number, y: number) => void) | undefined,
): {
  onPointerDown?: (event: PointerEvent) => void
  onPointerMove?: (event: PointerEvent) => void
  onPointerUp?: () => void
  onPointerCancel?: () => void
  onClickCapture?: (event: ReactMouseEvent) => void
} {
  const pending = useRef<{
    timer: ReturnType<typeof setTimeout>
    pointerId: number
    x: number
    y: number
  } | null>(null)
  const fired = useRef(false)

  return useMemo(() => {
    if (onLongPress === undefined) return {}
    const clear = () => {
      if (pending.current !== null) {
        clearTimeout(pending.current.timer)
        pending.current = null
      }
    }
    return {
      onPointerDown: (event: PointerEvent) => {
        // Reset here, not only in onClickCapture: after a native
        // contextmenu (Android) no click follows, and a stale flag would
        // swallow the NEXT genuine tap.
        fired.current = false
        if (event.pointerType !== 'touch') return
        const path = (event.target as Element)
          .closest?.('[data-doc-path]')
          ?.getAttribute('data-doc-path')
        if (path == null) return
        clear()
        const { clientX, clientY, pointerId } = event
        pending.current = {
          pointerId,
          x: clientX,
          y: clientY,
          timer: setTimeout(() => {
            pending.current = null
            fired.current = true
            onLongPress(path, clientX, clientY)
          }, LONG_PRESS_MS),
        }
      },
      onPointerMove: (event: PointerEvent) => {
        const held = pending.current
        if (held === null || event.pointerId !== held.pointerId) return
        if (Math.hypot(event.clientX - held.x, event.clientY - held.y) > MOVE_SLOP_PX) clear()
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onClickCapture: (event: ReactMouseEvent) => {
        if (!fired.current) return
        fired.current = false
        event.preventDefault()
        event.stopPropagation()
      },
    }
  }, [onLongPress])
}
