import { type RefObject, useEffect, useRef } from 'react'

/**
 * The first Tab stop of every page: one key past the shell and the page's
 * own header into what the page is for. Hidden until focused.
 */
export function SkipToContent() {
  const self = useRef<HTMLButtonElement | null>(null)
  useFirstTabFromArrival(self)
  return (
    // A button, not an `#anchor` link: the pages' `<main>` carries no id, and
    // what it skips to depends on the page (a canvas, an editor, the list).
    <button
      ref={self}
      type="button"
      onClick={focusPageContent}
      className="bg-background text-foreground sr-only rounded-md border px-3 py-1.5 text-sm shadow-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 pointer-coarse:min-h-11"
    >
      Skip to content
    </button>
  )
}

/**
 * A page's arrival puts focus on its heading, which sits after the shell's
 * header — so a plain Tab from there would pass this button by on the very
 * load it is for. The first Tab of the app's life, taken from a heading the
 * page focused itself (one no Tab reaches), comes here instead. Only the
 * first: moving between pages afterwards, Tab from a heading goes on into
 * that page, as a reader who has already met the skip link expects.
 */
function useFirstTabFromArrival(self: RefObject<HTMLButtonElement | null>): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
      document.removeEventListener('keydown', onKeyDown, true)
      const from = document.activeElement
      const arrival =
        from instanceof HTMLElement && /^H[1-6]$/.test(from.tagName) && from.tabIndex < 0
      if (!arrival || event.shiftKey || self.current === null) return
      event.preventDefault()
      self.current.focus()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [self])
}

/**
 * The page's content entry point: the canvas surface, a note's editor, or
 * else the page's `<main>` itself, so the next Tab is its first control.
 * An entry that is not drawn is skipped — a note in Read mode keeps its
 * editor mounted but hidden, and focusing that does nothing.
 */
function focusPageContent(): void {
  const main = document.querySelector<HTMLElement>('main')
  if (main === null) return
  const entry = shown(main, '[role="application"]') ?? shown(main, '[contenteditable="true"]')
  if (entry !== undefined) {
    entry.focus()
    return
  }
  if (!main.hasAttribute('tabindex')) main.tabIndex = -1
  main.focus()
}

const shown = (main: HTMLElement, selector: string) =>
  [...main.querySelectorAll<HTMLElement>(selector)].find(
    (element) => element.getClientRects().length > 0,
  )
