import type { ReactNode, Ref } from 'react'
import { cn } from '../../lib/utils.js'

/**
 * The two-row grid shell both document pages stand in.
 *
 * Everything header-shaped stacks inside the `auto` row, and the editor owns
 * `minmax(0,1fr)` — however many banner rows appear (or however tall they
 * wrap), the editor row is always exactly the remaining viewport height,
 * never clipped below it. Both pages carried this template and the sr-only
 * `<h1>` landmark by hand; owning them here means a layout or a11y drift
 * between the two modes cannot happen quietly.
 *
 * `aside` is the document's inspector — its history column or its comments
 * rail, whichever the page's one inspector slot holds. It rides in the editor
 * row rather than beside the whole page, so the top bar keeps the full width
 * and the aside is exactly as tall as the editor it belongs to. The row is
 * wrapped whether or not there is an aside: wrapping it only when one arrived
 * re-parented the editor, and React remounts what changes parent — so opening
 * the history column threw away the editor's own state (its viewport, its
 * selection) for a layout that had not changed. The wrapper is `relative`
 * because the aside is a column only where there is width for one: under
 * 768px it is a bottom sheet, positioned against this row so it covers the
 * editor and not the top bar above it.
 *
 * `mainRef` and `mainClassName` exist for one caller and one reason that
 * travel together: the browser page fullscreens this element, and a
 * fullscreened element without its own background is composited over black —
 * so it passes the ref it fullscreens and `bg-background` to stand behind
 * it. The daemon page has no fullscreen affordance and passes neither.
 */
export function DocumentPageShell({
  srTitle,
  header,
  children,
  aside,
  mainRef,
  mainClassName,
}: {
  /** The page's visually-hidden `<h1>` landmark text. */
  srTitle: string
  /** The header row's contents, after the landmark. */
  header: ReactNode
  /** The editor row, and any banner rows the page stacks above it. */
  children: ReactNode
  /** The document's inspector, beside the editor row (a sheet over it when narrow). */
  aside?: ReactNode
  mainRef?: Ref<HTMLElement>
  mainClassName?: string
}) {
  return (
    <main
      ref={mainRef}
      className={cn('relative grid h-full w-full grid-rows-[auto_minmax(0,1fr)]', mainClassName)}
    >
      <div className="min-w-0">
        <h1 className="sr-only">{srTitle}</h1>
        {header}
      </div>
      <div className="relative flex min-h-0 min-w-0">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        {aside}
      </div>
    </main>
  )
}
