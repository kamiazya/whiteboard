import { useEffect, useState } from 'react'

/**
 * Where the software keyboard is, read from the one signal the platform
 * gives a page: the visual viewport. Touch browsers overlay the keyboard
 * without resizing the layout viewport, so `innerHeight` stays put while
 * `visualViewport.height` shrinks; the difference (past any `offsetTop`
 * from iOS panning the visual viewport) is the strip the keyboard covers.
 * A hardware keyboard, or a desktop, never shrinks it: occlusion 0.
 */
export interface SoftwareKeyboardState {
  /** Layout-viewport px at the bottom the keyboard covers; 0 when it is down. */
  readonly occludedBottomPx: number
  /** The visual viewport's bottom edge in layout-viewport px — where a keyboard-docked bar sits. */
  readonly visualBottomPx: number
}

export function readSoftwareKeyboard(): SoftwareKeyboardState {
  const visual = window.visualViewport
  if (visual === null || visual === undefined) {
    return { occludedBottomPx: 0, visualBottomPx: window.innerHeight }
  }
  const visualBottomPx = visual.offsetTop + visual.height
  return {
    occludedBottomPx: Math.max(0, window.innerHeight - visualBottomPx),
    visualBottomPx,
  }
}

export function useSoftwareKeyboard(): SoftwareKeyboardState {
  const [state, setState] = useState<SoftwareKeyboardState>(readSoftwareKeyboard)
  useEffect(() => {
    const visual = window.visualViewport
    const update = () => setState(readSoftwareKeyboard())
    update()
    // resize covers the keyboard animating in and out; scroll covers iOS
    // panning its visual viewport, which moves the bottom edge without a
    // resize; window resize covers rotation.
    visual?.addEventListener('resize', update)
    visual?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      visual?.removeEventListener('resize', update)
      visual?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  return state
}
