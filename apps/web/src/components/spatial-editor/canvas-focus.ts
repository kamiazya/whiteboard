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
