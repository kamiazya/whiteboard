/**
 * The first Tab stop of every page: one key past the shell and the page's
 * own header into what the page is for. Hidden until focused.
 */
export function SkipToContent() {
  return (
    // A button, not an `#anchor` link: the pages' `<main>` carries no id, and
    // what it skips to depends on the page (a canvas, an editor, the list).
    <button
      type="button"
      onClick={focusPageContent}
      className="bg-background text-foreground sr-only rounded-md border px-3 py-1.5 text-sm shadow-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 pointer-coarse:min-h-11"
    >
      Skip to content
    </button>
  )
}

/**
 * The page's content entry point: the canvas surface, a note's editor, or
 * else the page's `<main>` itself, so the next Tab is its first control.
 */
function focusPageContent(): void {
  const main = document.querySelector<HTMLElement>('main')
  if (main === null) return
  const entry =
    main.querySelector<HTMLElement>('[role="application"]') ??
    main.querySelector<HTMLElement>('[contenteditable="true"]')
  if (entry !== null) {
    entry.focus()
    return
  }
  if (!main.hasAttribute('tabindex')) main.tabIndex = -1
  main.focus()
}
