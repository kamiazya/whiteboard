import type { MutableRefObject } from 'react'

/**
 * Whatever holds focus right now, as the place to hand it back to.
 *
 * Read from `activeElement` rather than named by each caller because every
 * surface that opens a rail or a menu already holds focus at the moment it
 * calls in: a parameter would be the same answer written out once per
 * surface, and the newest surface is the one that would forget.
 */
export function focusedElement(): HTMLElement | null {
  const active = document.activeElement
  // `document.body` needs no special case: it is what `activeElement`
  // answers when nothing is focused, and `focus()` on it is a no-op —
  // measured in Chromium, not assumed, after a guard against it turned out
  // to be unfalsifiable.
  return active instanceof HTMLElement ? active : null
}

export function captureFocusInto(ref: MutableRefObject<HTMLElement | null>): void {
  ref.current = focusedElement()
}
