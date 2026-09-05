/**
 * Subscribes to one of the document-sync window events, delivering only the
 * announcements addressed to THIS document.
 *
 * The events carry `{ workspaceId, path }` (see `dispatchIdentityEvent`),
 * and every consumer must check it: an unchecked listener refreshes on any
 * document's announcement — the browser page's version-refresh listener
 * had exactly that shape while the daemon page checked identity, the kind
 * of silent divergence the page unification exists to retire.
 */

import { useEffect, useRef } from 'react'
import type { DirtyEventDetail } from '../lib/document-sync-types.js'

export function useIdentityEvent(
  eventName: string,
  workspaceId: string,
  /** null while the page has no document yet; nothing is subscribed then. */
  path: string | null,
  handler: () => void,
): void {
  // The handler customises WHAT happens, not WHICH announcement this is —
  // a ref keeps an inline callback from resubscribing every render.
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (typeof window === 'undefined' || path === null) return
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<DirtyEventDetail>).detail
      if (!detail || detail.workspaceId !== workspaceId || detail.path !== path) return
      handlerRef.current()
    }
    window.addEventListener(eventName, onEvent)
    return () => window.removeEventListener(eventName, onEvent)
  }, [eventName, workspaceId, path])
}
