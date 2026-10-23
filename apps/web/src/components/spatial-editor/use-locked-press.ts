import type { PointerEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Point } from '../../lib/spatial/viewport.js'
import { type ContentPick, lockedNodeAbsorbsPress, type PickInputs } from './element-pick.js'

const NOTICE_MS = 3000
const DRAG_SLOP_PX = 10
const NOTICE = 'Locked — unlock from the menu'

/**
 * A press on a locked node stops there: it neither starts a marquee nor
 * reaches the frame or edge beneath, and a drag begun on it is answered with
 * a brief notice saying why nothing moves. The notice is transient by
 * design — it explains a refusal, so it leaves on its own.
 */
export function useLockedPress(pickInputs: PickInputs) {
  const [notice, setNotice] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const absorbed = useRef<{ readonly pointerId: number; readonly start: Point } | null>(null)

  const dismiss = useCallback(() => {
    clearTimeout(timer.current)
    setNotice(null)
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])

  return {
    notice,
    dismiss,
    /** True when the press landed on a locked node. Ink drawn over it still wins the press. */
    absorb: (e: PointerEvent, pick: ContentPick | undefined, canvasPoint: Point, screen: Point) => {
      if (pick?.kind === 'lines' || !lockedNodeAbsorbsPress(pickInputs, canvasPoint)) return false
      absorbed.current = { pointerId: e.pointerId, start: screen }
      return true
    },
    /** Past slop, the first move of an absorbed press says why nothing follows. */
    announceDrag: (e: PointerEvent, screen: Point) => {
      const press = absorbed.current
      if (press === null || press.pointerId !== e.pointerId) return
      if (Math.hypot(screen.x - press.start.x, screen.y - press.start.y) <= DRAG_SLOP_PX) return
      absorbed.current = null
      clearTimeout(timer.current)
      setNotice(NOTICE)
      timer.current = setTimeout(() => setNotice(null), NOTICE_MS)
    },
    release: () => {
      absorbed.current = null
    },
  }
}
