import { useCallback, useEffect, useRef, useState } from 'react'

/** How long an announcement stays in the live region before it is cleared. */
const ANNOUNCE_CLEAR_MS = 2000

/**
 * The text for a polite live region. Cleared after a beat so announcing the
 * same words twice in a row is still a change the reader's software sees.
 */
export function useAnnouncer(): {
  readonly announcement: string
  readonly announce: (text: string) => void
  /** A handler that speaks `text` after running `handler`; absent stays absent. */
  readonly announcing: <A extends unknown[]>(
    handler: ((...args: A) => void) | undefined,
    text: string,
  ) => ((...args: A) => void) | undefined
} {
  const [announcement, setAnnouncement] = useState('')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const announce = useCallback((text: string) => {
    window.clearTimeout(timer.current)
    setAnnouncement(text)
    timer.current = window.setTimeout(() => setAnnouncement(''), ANNOUNCE_CLEAR_MS)
  }, [])
  const announcing = <A extends unknown[]>(
    handler: ((...args: A) => void) | undefined,
    text: string,
  ) =>
    handler === undefined
      ? undefined
      : (...args: A) => {
          handler(...args)
          announce(text)
        }
  return { announcement, announce, announcing }
}

/**
 * Mounted before it speaks and `sr-only` rather than hidden: a live region
 * inserted already carrying its text is missed by several screen readers.
 */
export function AnnouncerRegion({ text }: { readonly text: string }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {text}
    </p>
  )
}
