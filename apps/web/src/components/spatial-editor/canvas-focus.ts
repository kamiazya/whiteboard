/**
 * An explicit exit (chord or button) from something drawn over the canvas
 * hands the keyboard back to the canvas it lives in, or Delete, arrows and
 * undo go to <body> and do nothing until the next click. A blur-driven exit
 * does not: focus has already gone where the person pointed it.
 */
export function returnFocusToCanvas(from: Element | null): void {
  from?.closest<HTMLElement>('[role="application"]')?.focus({ preventScroll: true })
}

/** Nothing holds focus: the surface that had it was removed from the page. */
export function focusIsLost(): boolean {
  return document.activeElement === null || document.activeElement === document.body
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

function isTabbable(element: HTMLElement): boolean {
  return element.tabIndex >= 0 && element.getClientRects().length > 0
}

/**
 * Moves focus from the canvas root to the next Tab stop after it in the page
 * (forward) or the last one before it (backward) — what Tab would do from the
 * root, without walking the selection there — wrapping round the page's ends.
 * Answers false only when nothing outside the canvas can take focus.
 */
export function focusPastCanvas(root: HTMLElement, direction: 1 | -1): boolean {
  const stops = [...document.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) => element === root || isTabbable(element),
  )
  const at = stops.indexOf(root)
  if (at < 0) return false
  // A control drawn inside the root (the dock, a link in a node) is still
  // the canvas, in both directions.
  const outside = (element: HTMLElement) => !root.contains(element)
  // Past the page's end it wraps, the way a browser's own F6 cycles its
  // regions: a key that sometimes does nothing reads as a key that is broken.
  const after = [...stops.slice(at + 1), ...stops.slice(0, at)]
  const target = (direction === 1 ? after : after.reverse()).find(outside)
  if (target === undefined) return false
  target.focus()
  return true
}
