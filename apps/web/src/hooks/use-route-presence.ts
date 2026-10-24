import type { DocumentKind, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { type RefObject, useEffect, useRef } from 'react'
import { documentArrival, pageTitle } from '../lib/document-title.js'
import { announceRoute, routeAnnouncementSnapshot } from '../lib/route-announcer.js'

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
  useEffect(() => {
    if (routeKey === null) return
    announceRoute(latest.current.announcement)
    arrivalSaid.current = latest.current.announcement
    const holder = document.activeElement
    if (latest.current.claimsFocus && (holder === null || holder === document.body)) {
      headingRef.current?.focus({ preventScroll: true })
    }
  }, [routeKey, headingRef])
  useEffect(() => {
    if (arrivalSaid.current === null || arrivalSaid.current === announcement) return
    if (routeAnnouncementSnapshot() === arrivalSaid.current) announceRoute(announcement)
    arrivalSaid.current = announcement
  }, [announcement])
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
  readonly sync: { readonly loaded: boolean; readonly canvas: SpatialCanvas }
}

/**
 * An open document. A fresh note's editor claims focus itself and declines
 * when anything else already holds it, so the heading stands aside for exactly
 * that case. A blank canvas is the same case for the canvas: its surface takes
 * the keyboard from the heading, so the first key after creating one (N for a
 * note) acts on the canvas. Returns the heading's ref.
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
  const { loaded, canvas } = model.sync
  const blank = kind === 'spatial' && loaded && canvas.nodes.length === 0 && !canvas.lines?.length
  useBlankCanvasTakesFocus(model.scopeKey, blank, headingRef)
  return headingRef
}

/**
 * Once per arrival, and only from the heading or from nowhere: a canvas
 * emptied later, or a person who has already moved on, keeps its focus.
 */
function useBlankCanvasTakesFocus(
  routeKey: string | null,
  blank: boolean,
  headingRef: RefObject<HTMLElement | null>,
): void {
  const handled = useRef<string | null>(null)
  useEffect(() => {
    if (routeKey === null || handled.current === routeKey || !blank) return
    handled.current = routeKey
    const holder = document.activeElement
    if (holder !== null && holder !== document.body && holder !== headingRef.current) return
    // The page has one main, and one canvas surface in it.
    document.querySelector<HTMLElement>('main [role="application"]')?.focus({ preventScroll: true })
  }, [routeKey, blank, headingRef])
}
