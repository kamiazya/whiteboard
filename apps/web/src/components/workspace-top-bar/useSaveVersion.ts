import { useCallback, useEffect, useRef, useState } from 'react'
import { useVersionsBackend } from '@/contexts/VersionsBackendContext'
import type { DirtyEventDetail } from '@/hooks/useDirtyState'
import type { AppLogger } from '@/lib/app-logger'

interface UseSaveVersionOptions {
  workspaceId: string
  path: string
  getThumbnailBlob: (() => Promise<Blob | null>) | undefined
  log?: AppLogger
}

// Owns the manual-save flow (save, optional thumbnail upload) plus the
// Cmd/Ctrl+S shortcut that triggers it. `saving` is exposed for
// HeaderSaveDot; `savingRef` stays internal because it exists only to dedupe
// re-entrant calls issued before React re-renders `saving`. Which keeper
// answers is the VersionsBackend's business.
export function useSaveVersion({
  workspaceId,
  path,
  getThumbnailBlob,
  log,
}: UseSaveVersionOptions) {
  const versions = useVersionsBackend()
  const [saving, setSaving] = useState(false)
  // `saving` state updates land on the next render, so two calls issued
  // before React re-renders both see the same stale `false`. Guard with a
  // ref instead, which is set/cleared synchronously and never causes the
  // keydown listener to be re-subscribed (kept out of saveVersion's deps).
  const savingRef = useRef(false)

  // Shared save flow: save, then upload a thumbnail if the keeper takes one.
  // Quick save passes an empty label.
  const saveVersion = useCallback(
    async (label = ''): Promise<boolean> => {
      if (savingRef.current) return false
      savingRef.current = true
      setSaving(true)
      try {
        let saved: Awaited<ReturnType<typeof versions.save>>
        try {
          saved = await versions.save(workspaceId, path, { label })
        } catch (err) {
          log?.error('save version failed:', err)
          return false
        }
        // Dispatch only once the keeper confirmed the save. A manual save can
        // bypass the daemon's version_created websocket path; a later WS
        // event becomes a no-op.
        if (typeof window !== 'undefined') {
          const detail: DirtyEventDetail = { workspaceId, path }
          window.dispatchEvent(new CustomEvent('whiteboard:wb_version_saved', { detail }))
        }
        if (saved.id && getThumbnailBlob && versions.putThumbnail) {
          try {
            const blob = await getThumbnailBlob()
            if (blob) await versions.putThumbnail(workspaceId, path, saved.id, blob)
          } catch (err) {
            log?.error('manual-save thumbnail upload failed:', err)
          }
        }
        return true
      } finally {
        savingRef.current = false
        setSaving(false)
      }
    },
    [workspaceId, path, getThumbnailBlob, log, versions],
  )

  return { saving, savingRef, saveVersion }
}

// Cmd/Ctrl+S performs a quick save.
// Excalidraw can focus an offscreen contenteditable for clipboard or IME work, which makes
// browser-level heuristics think the user is typing and can reopen the native Save Page dialog.
// Capture the shortcut unconditionally here because the canvas has no competing native save meaning.
export function useQuickSaveShortcut(
  enabled: boolean,
  saveVersion: (label?: string) => Promise<boolean>,
) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      const isSave = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && !e.shiftKey
      if (!isSave) return
      e.preventDefault()
      e.stopPropagation()
      void saveVersion('')
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () =>
      window.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions)
  }, [saveVersion, enabled])
}
