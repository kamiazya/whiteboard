import { useEffect } from 'react'

/**
 * ⌘/Ctrl+S asks for a bookmark; it no longer takes one.
 *
 * Under automatic checkpoints there is nothing to "save" — the state is
 * already held. What the chord means now is "mark this point", and a mark
 * without a name is indistinguishable from the checkpoint beside it, so it
 * opens the naming field instead of writing a row.
 *
 * Captured unconditionally: the canvas can focus an offscreen
 * contenteditable for clipboard or IME work, which makes the browser's own
 * heuristics reopen the native Save Page dialog.
 */
export function useBookmarkShortcut(enabled: boolean, onRequest: () => void) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      const isSave = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && !e.shiftKey
      if (!isSave) return
      e.preventDefault()
      e.stopPropagation()
      onRequest()
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () =>
      window.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions)
  }, [onRequest, enabled])
}
