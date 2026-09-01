import { type MutableRefObject, type RefObject, useEffect, useRef } from 'react'
import { describeTarget, gestureTrace } from './gesture-trace.js'

/**
 * The editor's NATIVE listeners — the ones React's synthetic system cannot
 * express — plus the unmount teardown for platform state React does not
 * release. Everything here is mount-scoped machinery; no editor state lives
 * in this hook.
 */
export function useNativeCanvasListeners<T extends { timer: ReturnType<typeof setTimeout> }>(
  rootRef: RefObject<HTMLDivElement | null>,
  /**
   * The wheel handler, taken through a per-render write into a ref so the
   * native listener always calls the LATEST closure. React registers onWheel
   * as a PASSIVE listener (matching the browser's own default for
   * scroll-affecting events), so e.preventDefault() from a React handler is
   * silently ignored; Ctrl/Cmd+wheel zoom needs to suppress the browser's
   * own page-zoom/scroll, which only a { passive: false } NATIVE listener
   * can do.
   */
  onWheel: (e: WheelEvent) => void,
  longPressRef: MutableRefObject<T | null>,
  activePointerIdRef: MutableRefObject<number | null>,
): void {
  const handleWheelRef = useRef(onWheel)
  handleWheelRef.current = onWheel

  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const wheel = (e: WheelEvent) => handleWheelRef.current(e)
    root.addEventListener('wheel', wheel, { passive: false })
    return () => root.removeEventListener('wheel', wheel)
  }, [rootRef])

  // iOS Safari's native long-press behaviors (selection loupe, callout,
  // the haptic-touch takeover) ignore `touch-action` and CSS user-select
  // suppression in practice: the system claims the press and fires
  // pointercancel, which disarms the app's own long-press menu timer —
  // the press is "hijacked". preventDefault on `touchstart` is the one
  // reliable off-switch for that entire family, and it must be a
  // NON-PASSIVE native listener (React's synthetic handlers don't
  // guarantee that, and browsers default touch listeners to passive).
  // Canvas interactions are pointer-event driven and unaffected —
  // pointerdown has already fired by the time touchstart is cancelled;
  // what this suppresses is the native gesture claim plus the synthetic
  // mouse-compatibility events the canvas never uses. Overlays
  // (`data-editor-overlay`: text editor, palette, menus, dialogs) keep
  // native touch semantics — they hold real form controls.
  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const refuseNativeTouch = (event: TouchEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-editor-overlay]') !== null
      ) {
        return
      }
      event.preventDefault()
    }
    root.addEventListener('touchstart', refuseNativeTouch, { passive: false })
    // touchmove too, not just touchstart: an embedding sheet (iOS's
    // SFSafariViewController in-app browser) decides from UNCONSUMED move
    // events whether a drag is ITS drag — a canvas pan was dragging the
    // whole sheet up and down. Canvas gestures are pointer-event driven
    // and unaffected.
    root.addEventListener('touchmove', refuseNativeTouch, { passive: false })
    return () => {
      root.removeEventListener('touchstart', refuseNativeTouch)
      root.removeEventListener('touchmove', refuseNativeTouch)
    }
  }, [rootRef])

  // The flight recorder's document-side ear. The root's own handlers can
  // only record presses that REACH them, and the report this recorder
  // exists for is precisely a press that seems not to: an element outside
  // the root — a portal, a stale overlay — consumes it before the editor
  // sees anything. A capture-phase listener on the document sees every
  // press first and records whether it was headed inside the root, which
  // is the discriminator nothing else can supply. Down/up/cancel only:
  // moves would flood the ring, and the missing-press question never
  // needs them.
  useEffect(() => {
    const record = (e: PointerEvent) => {
      const root = rootRef.current
      gestureTrace.recordDocPointer({
        at: Math.round(e.timeStamp),
        type: e.type,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        isPrimary: e.isPrimary,
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        insideRoot: root !== null && e.target instanceof Node && root.contains(e.target),
        target: describeTarget(e.target),
      })
    }
    document.addEventListener('pointerdown', record, true)
    document.addEventListener('pointerup', record, true)
    document.addEventListener('pointercancel', record, true)
    return () => {
      document.removeEventListener('pointerdown', record, true)
      document.removeEventListener('pointerup', record, true)
      document.removeEventListener('pointercancel', record, true)
    }
  }, [rootRef])

  // Unmount-mid-gesture safety net. Every pointer handler is a JSX prop
  // (the wheel listener above is the editor's only root-native one, and it
  // already cleans itself up), so React tears them all down with the
  // component and no stale handler can fire an onChange/command after
  // this point — that half of "no listener leak" is structural, not
  // something this effect needs to do. What React does NOT do for us is
  // release pointer capture the platform is still holding on our behalf;
  // an unmount mid-drag (route change, a parent swapping this component
  // out) would otherwise leave the browser holding capture for a pointer
  // no element can any longer respond to. Best-effort/never-throw, same
  // reasoning as `trySetPointerCapture`.
  useEffect(() => {
    // Capture the root HERE, at mount, rather than reading `rootRef.current`
    // inside the cleanup closure: React detaches the ref (sets it to
    // `null`) before this cleanup runs on unmount, so reading the ref at
    // cleanup time would always see `null` and silently skip the release.
    const root = rootRef.current
    return () => {
      // A long-press timer must not fire into an unmounted editor.
      if (longPressRef.current !== null) {
        clearTimeout(longPressRef.current.timer)
        longPressRef.current = null
      }
      const pointerId = activePointerIdRef.current
      if (root === null || pointerId === null) return
      try {
        root.releasePointerCapture(pointerId)
      } catch {
        // best-effort — see doc comment above
      }
    }
  }, [rootRef, longPressRef, activePointerIdRef])
}
