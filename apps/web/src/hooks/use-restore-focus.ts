import { useEffect, useState } from 'react'
import { focusedElement } from '../lib/capture-focus.js'

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
  const [opener] = useState(focusedElement)
  useEffect(
    () => () => {
      const active = document.activeElement
      if (active === null || active === document.body) opener?.focus()
    },
    [opener],
  )
}
