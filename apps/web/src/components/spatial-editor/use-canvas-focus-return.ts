import { type RefObject, useEffect, useRef } from 'react'
import { focusIsLost } from './canvas-focus.js'
import type { GestureState } from './gestures.js'

/**
 * Calls `returnFocus` when a surface that was open closes and took focus with
 * it. Unmounting a focused element leaves focus on <body>, and a dialog's own
 * restore aims at the control that opened it, which may be gone too. A
 * surface that handed focus somewhere on purpose (an editor it opened) keeps
 * it: the check runs a frame later, once that has happened.
 */
export function useReturnFocusWhenClosed(open: boolean, returnFocus: (() => void) | undefined) {
  const wasOpen = useRef(open)
  const returnRef = useRef(returnFocus)
  returnRef.current = returnFocus
  useEffect(() => {
    const before = wasOpen.current
    wasOpen.current = open
    if (!before || open) return
    const frame = requestAnimationFrame(() => {
      if (focusIsLost()) returnRef.current?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])
}

/**
 * The canvas's own transient surfaces: a dialog, or a connect whose attach
 * targets are the focusable things. When either ends, the keyboard returns to
 * the canvas root unless something else took it.
 */
export function useCanvasFocusReturn(
  rootRef: RefObject<HTMLElement | null>,
  gestureState: GestureState,
  ...dialogs: readonly unknown[]
): void {
  const connecting = gestureState.kind === 'connecting' || gestureState.kind === 'reattaching'
  const open = connecting || dialogs.some((dialog) => dialog !== null)
  useReturnFocusWhenClosed(open, () => rootRef.current?.focus({ preventScroll: true }))
}
