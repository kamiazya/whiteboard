/**
 * App-shell gesture guards for touch browsers, iOS Safari first.
 *
 * Safari implements pinch-to-zoom through its own proprietary gesture
 * events and IGNORES both the viewport meta's `user-scalable=no` (since
 * iOS 10, in-browser) and `touch-action` for the page-zoom gesture — so an
 * app that owns its gestures (the canvas pinch-zooms the canvas, not the
 * page) must cancel `gesturestart`/`gesturechange` at the document. Pointer
 * events are unaffected: the spatial editor's own pinch handling keeps
 * working; what this removes is the PAGE scaling underneath it.
 *
 * Browsers without the gesture events (everything but WebKit/Safari)
 * simply never fire them — installing the listeners is inert there, where
 * the viewport meta and `touch-action` already cover zoom suppression.
 *
 * Accessibility note: OS-level zoom (iOS Settings > Accessibility > Zoom)
 * is a system feature and is not affected by page-level gesture handling.
 */
export function installMobileAppShellGuards(target: Document = document): () => void {
  const prevent = (event: Event) => {
    event.preventDefault()
  }
  // Not passive: preventDefault is the entire point.
  target.addEventListener('gesturestart', prevent)
  target.addEventListener('gesturechange', prevent)
  return () => {
    target.removeEventListener('gesturestart', prevent)
    target.removeEventListener('gesturechange', prevent)
  }
}
