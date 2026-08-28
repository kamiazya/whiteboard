import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirtyEventDetail } from '../lib/document-sync-types.js'

// Re-exported so existing call sites (e.g. WorkspaceTopBar) can keep
// importing this from the hook module; the canonical definition lives in
// lib/document-sync-types.ts alongside dispatchIdentityEvent, which produces it.
export type { DirtyEventDetail }

// Track unsaved state with the same minimal affordance as a mail-style unread dot.
// - default (dirty=false): show nothing
// - dirty: show an amber dot in the header
//
// Implementation notes:
//  useWhiteboardSync dispatches whiteboard:doc_changed whenever doc.subscribe observes a local or remote edit.
//  When version_created arrives, it dispatches whiteboard:wb_version_saved.
//  This hook filters those events by workspaceId/path and tracks dirty vs clean counts.
//  Passing the doc reference around would couple tests to Loro internals, so this stays event-based.

export interface UseDirtyStateResult {
  isDirty: boolean
  // Call this when the UI needs to mark the document clean explicitly, such as right after Cmd+S succeeds.
  // Most callers can rely on whiteboard:wb_version_saved instead.
  markSaved: () => void
}

export function useDirtyState(workspaceId: string, path: string): UseDirtyStateResult {
  const [isDirty, setIsDirty] = useState(false)
  const changeCountRef = useRef(0)
  const savedAtRef = useRef(0)

  // Reset counters when switching documents; a new document starts clean.
  useEffect(() => {
    changeCountRef.current = 0
    savedAtRef.current = 0
    setIsDirty(false)
  }, [workspaceId, path])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<DirtyEventDetail>).detail
      if (!detail || detail.workspaceId !== workspaceId || detail.path !== path) return
      changeCountRef.current += 1
      if (changeCountRef.current > savedAtRef.current) setIsDirty(true)
    }
    const onSaved = (event: Event) => {
      const detail = (event as CustomEvent<DirtyEventDetail>).detail
      if (!detail || detail.workspaceId !== workspaceId || detail.path !== path) return
      savedAtRef.current = changeCountRef.current
      setIsDirty(false)
    }
    window.addEventListener('whiteboard:doc_changed', onChanged)
    window.addEventListener('whiteboard:wb_version_saved', onSaved)
    return () => {
      window.removeEventListener('whiteboard:doc_changed', onChanged)
      window.removeEventListener('whiteboard:wb_version_saved', onSaved)
    }
  }, [workspaceId, path])

  const markSaved = useCallback(() => {
    savedAtRef.current = changeCountRef.current
    setIsDirty(false)
  }, [])

  return { isDirty, markSaved }
}
