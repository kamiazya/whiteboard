import { createContext, useContext, useEffect, useState } from 'react'

/** How long a confirmation stays in the status region before it is cleared. */
export const NOTICE_LIFETIME_MS = 4000

/**
 * Says a one-line confirmation through the document row's polite status
 * region. Passing null clears it, which is how a repeated identical message
 * is announced again: a live region speaks a CHANGE of text, not a re-render.
 */
export type AnnounceNotice = (message: string | null) => void

const AnnounceNoticeContext = createContext<AnnounceNotice>(() => {})

export const AnnounceNoticeProvider = AnnounceNoticeContext.Provider

/**
 * A menu item in a keeper's slot cannot be handed the page's setter through
 * the model, so it reaches it by context; outside a page it is a no-op.
 */
export function useAnnounceNotice(): AnnounceNotice {
  return useContext(AnnounceNoticeContext)
}

/** The page's current notice and the setter, cleared after a few seconds. */
export function useTransientNotice(): readonly [string | null, AnnounceNotice] {
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => setNotice(null), NOTICE_LIFETIME_MS)
    return () => clearTimeout(timer)
  }, [notice])
  return [notice, setNotice]
}
