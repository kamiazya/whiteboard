import type { ReactNode, Ref } from 'react'
import { cn } from '@/lib/utils'

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
  mainRef,
  mainClassName,
}: {
  /** The page's visually-hidden `<h1>` landmark text. */
  srTitle: string
  /** The header row's contents, after the landmark. */
  header: ReactNode
  /** The editor row, and any banner rows the page stacks above it. */
  children: ReactNode
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
      {children}
    </main>
  )
}
