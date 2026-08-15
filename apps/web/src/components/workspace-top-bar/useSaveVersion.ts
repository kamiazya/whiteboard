import { canvasesApiUrl, saveVersionResponseSchema } from '@kamiazya/whiteboard-mcp/api-contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirtyEventDetail } from '@/hooks/useDirtyState'
import type { AppLogger } from '@/lib/app-logger'

interface UseSaveVersionOptions {
  workspaceId: string
  slug: string
  daemonFetch: typeof globalThis.fetch
  getThumbnailBlob: (() => Promise<Blob | null>) | undefined
  log?: AppLogger
}

// Owns the manual-save flow (POST /versions, optional thumbnail upload) plus
// the Cmd/Ctrl+S shortcut that triggers it. `saving` is exposed for
// HeaderSaveDot; `savingRef` stays internal because it exists only to dedupe
// re-entrant calls issued before React re-renders `saving`.
export function useSaveVersion({
  workspaceId,
  slug,
  daemonFetch,
  getThumbnailBlob,
  log,
}: UseSaveVersionOptions) {
  const [saving, setSaving] = useState(false)
  // `saving` state updates land on the next render, so two calls issued
  // before React re-renders both see the same stale `false`. Guard with a
  // ref instead, which is set/cleared synchronously and never causes the
  // keydown listener to be re-subscribed (kept out of saveVersion's deps).
  const savingRef = useRef(false)

  // Shared save flow: POST /versions, then upload a thumbnail if available.
  // Quick save passes an empty label.
  const saveVersion = useCallback(
    async (label = ''): Promise<boolean> => {
      if (savingRef.current) return false
      savingRef.current = true
      setSaving(true)
      try {
        const res = await daemonFetch(canvasesApiUrl(workspaceId, slug, 'versions'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label }),
        })
        if (!res.ok) return false
        const parsed = saveVersionResponseSchema.safeParse(await res.json().catch(() => null))
        if (!parsed.success) {
          log?.error('POST /versions response did not match schema:', parsed.error)
          return false
        }
        // Dispatch only after schema validation confirms the server response is well-formed.
        // Manual save can bypass the server's version_created websocket path; a later WS event becomes a no-op.
        if (typeof window !== 'undefined') {
          const detail: DirtyEventDetail = { workspaceId, slug }
          window.dispatchEvent(new CustomEvent('excalidraw:wb_version_saved', { detail }))
        }
        const id = parsed.data.version.id
        if (id && getThumbnailBlob) {
          try {
            const blob = await getThumbnailBlob()
            if (blob) {
              await daemonFetch(canvasesApiUrl(workspaceId, slug, `versions/${id}/thumbnail`), {
                method: 'PUT',
                headers: { 'Content-Type': 'image/png' },
                body: blob,
              })
            }
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
    [workspaceId, slug, getThumbnailBlob, log, daemonFetch],
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
