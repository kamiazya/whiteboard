import {
  type PointerEvent,
  type MouseEvent as ReactMouseEvent,
  useContext,
  useMemo,
  useRef,
} from 'react'
import { type FolderActions, FolderActionsContext } from './folder-actions.js'

/** Matches the platform's own long-press feel (iOS/Android context menus). */
export const LONG_PRESS_MS = 500
/** A hold that drifts this far is a scroll, not a press. */
const MOVE_SLOP_PX = 8

/** The release listener armed by the latest hold; one hold at a time has a finger down. */
let disarmPending: (() => void) | null = null

/**
 * Swallows the one click the hold that just opened a menu still delivers.
 *
 * `onClickCapture` on the list only covers a click that lands inside the
 * list. The menu is a sheet over the finger, outside it, and the release can
 * activate the item under the thumb — a different action than the one asked
 * for. A capture listener on the window sees that click wherever it lands.
 * The next press of any kind disarms it, so a genuine tap is never eaten and
 * a hold whose release produces no click (Android's native contextmenu)
 * leaves nothing behind.
 */
function swallowReleaseClick(): void {
  disarmPending?.()
  const eat = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    disarm()
  }
  const disarm = () => {
    disarmPending = null
    window.removeEventListener('click', eat, true)
    window.removeEventListener('pointerdown', disarm, true)
  }
  window.addEventListener('click', eat, true)
  window.addEventListener('pointerdown', disarm, true)
  disarmPending = disarm
}

/** What a hold on `target` opens — a document's menu or a folder's — or nothing. */
function heldMenu(
  target: Element,
  onLongPress: ((path: string, x: number, y: number) => void) | undefined,
  folders: FolderActions | undefined,
): ((x: number, y: number) => void) | undefined {
  const docPath = target.closest?.('[data-doc-path]')?.getAttribute('data-doc-path')
  if (docPath != null && onLongPress !== undefined) {
    return (x, y) => onLongPress(docPath, x, y)
  }
  const folderPath = target.closest?.('[data-folder-path]')?.getAttribute('data-folder-path')
  if (folderPath != null && folders !== undefined) {
    return (x, y) => folders.openFolderMenu(folderPath, x, y)
  }
  return undefined
}

/**
 * Container-level long-press → object menu, for lists of document cards
 * and folders.
 *
 * One hook per LIST, not per card: the cards are rendered inline in a map,
 * where a per-card hook cannot live, and a timer held in per-render state
 * would be lost to any re-render that happens mid-hold. The card is found
 * from the event target's closest `[data-doc-path]`, which each list
 * already has reason to stamp. A folder is found the same way by
 * `[data-folder-path]` and opens the folder menu the panel offers through
 * context, so a surface with folders but no document menu still has it.
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
  const folders = useContext(FolderActionsContext)

  return useMemo(() => {
    if (onLongPress === undefined && folders === undefined) return {}
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
        const open = heldMenu(event.target as Element, onLongPress, folders)
        if (open === undefined) return
        clear()
        const { clientX, clientY, pointerId } = event
        pending.current = {
          pointerId,
          x: clientX,
          y: clientY,
          timer: setTimeout(() => {
            pending.current = null
            fired.current = true
            swallowReleaseClick()
            open(clientX, clientY)
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
  }, [onLongPress, folders])
}
