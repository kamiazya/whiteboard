import type { DocumentKind, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { type RefObject, useEffect, useRef } from 'react'
import { documentArrival, pageTitle } from '../lib/document-title.js'
import { listDeparture, settleListDeparture } from '../lib/list-departure.js'
import { announceRoute, routeAnnouncementSnapshot } from '../lib/route-announcer.js'

/** Nothing holds focus: the page has not given it to anything yet. */
function focusIsUnclaimed(): boolean {
  const holder = document.activeElement
  return holder === null || holder === document.body
}

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
  // What this page last said on arrival. A name that resolves or changes
  // afterwards would leave that text stale, so it is replaced — but only while
  // it is still what the region holds: a later message (a rename receipt)
  // stays.
  const arrivalSaid = useRef<string | null>(null)
  // The arrival whose heading has not taken focus yet. A page's header can
  // mount after its body (a document's does), so the focus waits for the
  // heading rather than being attempted once against nothing.
  const headingOwed = useRef<string | null>(null)
  useEffect(() => {
    if (routeKey === null) return
    announceRoute(latest.current.announcement)
    arrivalSaid.current = latest.current.announcement
    headingOwed.current = latest.current.claimsFocus ? routeKey : null
  }, [routeKey])
  // Every render, until paid: the heading is focused once it exists, unless
  // something else has taken focus meanwhile.
  useEffect(() => {
    if (headingOwed.current === null || headingOwed.current !== routeKey) return
    if (!latest.current.claimsFocus || !focusIsUnclaimed()) {
      headingOwed.current = null
      return
    }
    if (headingRef.current === null) return
    headingRef.current.focus({ preventScroll: true })
    headingOwed.current = null
  })
  useEffect(() => {
    if (arrivalSaid.current === null || arrivalSaid.current === announcement) return
    if (routeAnnouncementSnapshot() === arrivalSaid.current) announceRoute(announcement)
    arrivalSaid.current = announcement
  }, [announcement])
}

/**
 * The document list: its heading takes focus — or, coming back from a
 * document the list opened, that document's card, so the person resumes
 * where they left rather than at the top. Returns the heading's ref.
 */
export function useListRoutePresence(): RefObject<HTMLHeadingElement | null> {
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  useRoutePresence({
    routeKey: 'documents',
    title: 'Documents',
    announcement: 'Documents',
    headingRef,
  })
  useReturnToCard(headingRef)
  return headingRef
}

/**
 * The card arrives after the listing does, so it is watched for — and only
 * taken while focus is still where arrival put it: a person who has started
 * moving keeps their place.
 */
function useReturnToCard(headingRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const path = listDeparture()
    if (path === null) return
    const selector = `main [data-doc-path="${CSS.escape(path)}"]`
    const unmoved = () => focusIsUnclaimed() || document.activeElement === headingRef.current
    const attempt = (): boolean => {
      const card = unmoved() ? document.querySelector<HTMLElement>(selector) : null
      if (unmoved() && card === null) return false
      card?.focus({ preventScroll: false })
      settleListDeparture(path)
      return true
    }
    if (attempt()) return
    const observer = new MutationObserver(() => {
      if (attempt()) observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [headingRef])
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
  readonly sync: { readonly loaded: boolean; readonly canvas: SpatialCanvas }
}

/**
 * An open document. A fresh note's editor claims focus itself and declines
 * when anything else already holds it, so the heading stands aside for exactly
 * that case. A canvas's surface takes the keyboard from the heading, so the
 * first key after opening one (N for a note, an arrow to walk its nodes) acts
 * on the canvas — the canvas IS the page's content, where a note's heading
 * sits directly above its text. Returns the heading's ref.
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
  useCanvasTakesFocus(model.scopeKey, kind === 'spatial' && model.sync.loaded, headingRef)
  return headingRef
}

/**
 * Once per arrival, and only from the heading or from nowhere: a person who
 * has already moved on keeps their focus. The surface mounts after its lazy
 * chunk, so this waits for it rather than looking once.
 */
function useCanvasTakesFocus(
  routeKey: string | null,
  ready: boolean,
  headingRef: RefObject<HTMLElement | null>,
): void {
  const handled = useRef<string | null>(null)
  useEffect(() => {
    if (routeKey === null || handled.current === routeKey || !ready) return
    if (!focusIsUnclaimed() && document.activeElement !== headingRef.current) {
      handled.current = routeKey
      return
    }
    // The page has one main, and one canvas surface in it.
    const surface = document.querySelector<HTMLElement>('main [role="application"]')
    if (surface === null) return
    handled.current = routeKey
    surface.focus({ preventScroll: true })
  })
}
