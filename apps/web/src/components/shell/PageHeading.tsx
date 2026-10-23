import type { ReactNode, Ref } from 'react'

/**
 * A page's `<h1>`: the list's visible heading, or the screen-reader-only one a
 * document page keeps beside its editable title. Focusable by script but not
 * by Tab — a route change moves focus here (hooks/use-route-presence.ts), and
 * a heading in the tab order would be a stop that does nothing. It takes no
 * focus ring either: nothing here can be activated, and a thick outline
 * round the page title on every return read as a control that was selected.
 */
export function PageHeading({
  headingRef,
  srOnly = false,
  children,
}: {
  headingRef?: Ref<HTMLHeadingElement> | undefined
  srOnly?: boolean
  children: ReactNode
}) {
  return (
    <h1
      ref={headingRef}
      tabIndex={-1}
      className={srOnly ? 'sr-only' : 'mb-3 truncate text-lg font-semibold outline-none'}
    >
      {children}
    </h1>
  )
}
