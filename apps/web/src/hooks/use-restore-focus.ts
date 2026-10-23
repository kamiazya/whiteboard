import { useEffect, useState } from 'react'

/**
 * For a surface that takes focus when it opens: hands focus back to whatever
 * held it, once the surface unmounts.
 *
 * Captured during the first render, before the surface takes focus, and
 * never re-read: an effect replayed under StrictMode would capture the
 * surface itself. Restored only when focus has nowhere else to be, because
 * a chosen item may open an editor that took it, and a press on another
 * control moved it there already.
 */
export function useRestoreFocus(): void {
  // SVG controls hold focus too (the canvas's own tool handles are shapes),
  // so the opener is any focusable element, not only an HTMLElement.
  const [opener] = useState(() => {
    const active = document.activeElement
    return active instanceof HTMLElement || active instanceof SVGElement ? active : null
  })
  useEffect(
    () => () => {
      const active = document.activeElement
      if (active === null || active === document.body) opener?.focus()
    },
    [opener],
  )
}
