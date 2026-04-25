import { useCallback, useEffect, useRef, useState } from 'react'

// Track unsaved state with the same minimal affordance as a mail-style unread dot.
// - default (dirty=false): show nothing
// - dirty: show an amber dot in the header
//
// Implementation notes:
//  useWhiteboardSync dispatches excalidraw:doc_changed whenever doc.subscribe observes a local or remote edit.
//  When version_created arrives, it dispatches excalidraw:version_saved.
//  This hook filters those events by sessionId/slug and tracks dirty vs clean counts.
//  Passing the doc reference around would couple tests to Loro internals, so this stays event-based.

export interface UseDirtyStateResult {
  isDirty: boolean
  // Call this when the UI needs to mark the document clean explicitly, such as right after Cmd+S succeeds.
  // Most callers can rely on excalidraw:version_saved instead.
  markSaved: () => void
}

export interface DirtyEventDetail {
  sessionId: string
  slug: string
}

export function useDirtyState(sessionId: string, slug: string): UseDirtyStateResult {
  const [isDirty, setIsDirty] = useState(false)
  const changeCountRef = useRef(0)
  const savedAtRef = useRef(0)

  // Reset counters when switching canvases; a new document starts clean.
  useEffect(() => {
    changeCountRef.current = 0
    savedAtRef.current = 0
    setIsDirty(false)
  }, [sessionId, slug])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<DirtyEventDetail>).detail
      if (!detail || detail.sessionId !== sessionId || detail.slug !== slug) return
      changeCountRef.current += 1
      if (changeCountRef.current > savedAtRef.current) setIsDirty(true)
    }
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<DirtyEventDetail>).detail
      if (!detail || detail.sessionId !== sessionId || detail.slug !== slug) return
      savedAtRef.current = changeCountRef.current
      setIsDirty(false)
    }
    window.addEventListener('excalidraw:doc_changed', onChanged)
    window.addEventListener('excalidraw:version_saved', onSaved)
    return () => {
      window.removeEventListener('excalidraw:doc_changed', onChanged)
      window.removeEventListener('excalidraw:version_saved', onSaved)
    }
  }, [sessionId, slug])

  const markSaved = useCallback(() => {
    savedAtRef.current = changeCountRef.current
    setIsDirty(false)
  }, [])

  return { isDirty, markSaved }
}
