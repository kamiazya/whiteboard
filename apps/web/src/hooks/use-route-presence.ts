import type { DocumentKind } from '@kamiazya/whiteboard-model'
import { type RefObject, useEffect, useRef } from 'react'
import { documentArrival, pageTitle } from '../lib/document-title.js'
import { announceRoute } from '../lib/route-announcer.js'

/** Sets the tab title while the page is mounted, and gives the tab back to the app after. */
function useTabTitle(name: string): void {
  useEffect(() => {
    document.title = pageTitle(name)
  }, [name])
  useEffect(
    () => () => {
      document.title = 'Whiteboard'
    },
    [],
  )
}

/**
 * What arriving on a page does for someone who cannot see it arrive: the tab
 * title, one polite announcement, and focus on the page's own heading.
 *
 * `routeKey` names the place; the announcement and focus fire when it changes
 * (null means the page is not yet anywhere), while a rename only retitles.
 * Focus is taken from `<body>` alone — a control that already holds it is not
 * this hook's to move. `claimsFocus: false` is for a page whose editor takes
 * focus itself: a heading holding it first would make that editor decline.
 */
function useRoutePresence({
  routeKey,
  title,
  announcement,
  headingRef,
  claimsFocus = true,
}: {
  routeKey: string | null
  title: string
  announcement: string
  headingRef: RefObject<HTMLElement | null>
  claimsFocus?: boolean
}): void {
  useTabTitle(title)
  const latest = useRef({ announcement, claimsFocus })
  latest.current = { announcement, claimsFocus }
  useEffect(() => {
    if (routeKey === null) return
    announceRoute(latest.current.announcement)
    const holder = document.activeElement
    if (latest.current.claimsFocus && (holder === null || holder === document.body)) {
      headingRef.current?.focus({ preventScroll: true })
    }
  }, [routeKey, headingRef])
}

/** The document list: its heading takes focus. Returns the heading's ref. */
export function useListRoutePresence(): RefObject<HTMLHeadingElement | null> {
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  useRoutePresence({
    routeKey: 'documents',
    title: 'Documents',
    announcement: 'Documents',
    headingRef,
  })
  return headingRef
}

/**
 * Settings draws a phone-width list heading and a section heading together,
 * and which one is on screen is CSS's to say — so no heading takes focus.
 */
export function useSettingsRoutePresence(): void {
  useRoutePresence({
    routeKey: 'settings',
    title: 'Settings',
    announcement: 'Settings',
    headingRef: useRef(null),
    claimsFocus: false,
  })
}

/** The slice of a document page's model its arrival depends on. */
interface DocumentArrivalModel {
  readonly scopeKey: string | null
  readonly srTitle: string
  readonly markdown: {
    readonly autoFocus?: boolean
    readonly hydrating: boolean
    readonly body: string | null
  }
}

/**
 * An open document. A fresh note's editor claims focus itself and declines
 * when anything else already holds it, so the heading stands aside for exactly
 * that case. Returns the heading's ref.
 */
export function useDocumentRoutePresence(
  model: DocumentArrivalModel,
  kind: DocumentKind,
): RefObject<HTMLHeadingElement | null> {
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const { autoFocus, hydrating, body } = model.markdown
  useRoutePresence({
    routeKey: model.scopeKey,
    title: model.srTitle,
    announcement: documentArrival(model.srTitle, kind),
    headingRef,
    claimsFocus: !(kind === 'markdown' && autoFocus === true && (hydrating || body === '')),
  })
  return headingRef
}
