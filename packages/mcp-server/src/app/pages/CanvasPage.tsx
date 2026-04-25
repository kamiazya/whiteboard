import React, { useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Excalidraw, exportToBlob } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { Minimize2, RotateCcw } from 'lucide-react'
import { useWhiteboardSync } from '../hooks/useWhiteboardSync.js'
import WorkspaceTopBar from '../components/WorkspaceTopBar.js'
import { MergeToast } from '../components/MergeToast.js'
import { MergeHighlight } from '../components/MergeHighlight.js'
import { HeaderBranchBanner } from '../components/HeaderBranchBanner.js'
import { Button } from '@/components/ui/button'
import {
  getHashLibraryUrl,
  getImportableLibraryUrl,
  getInstalledLibraryUrls,
} from '../lib/library-url.js'
import { normalizeLibraryPayload } from '../lib/library-payload.js'
import { apiFetch } from '../lib/api-client.js'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

export default function CanvasPage() {
  const params = useParams<{ sessionId: string; '*': string }>()
  const sessionId = params.sessionId!
  const slug = params['*'] ?? ''

  // Read ?fullscreen=1 once as the initial value.
  // Keep later toggles in local state so fullscreen changes do not pollute browser history.
  const [searchParams] = useSearchParams()
  const [isFullscreen, setIsFullscreen] = useState(searchParams.get('fullscreen') === '1')
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)

  // apiRef is assigned in handleApiReady, so it is null immediately after mount.
  // onVersionCreated is read through a ref inside the hook, so recreating it on each render is fine.
  const { onApiReady, onSceneChange, clearLocalUndo, restoreInProgress, restoreLabel } = useWhiteboardSync(sessionId, slug, {
    onVersionCreated: async (v) => {
      // Only generate thumbnails for auto-save. Manual save already uploads one from the header flow.
      if (!v.auto) return
      try {
        const blob = await getThumbnailBlob()
        if (!blob) return
        await apiFetch(
          `/api/workspaces/${sessionId}/canvases/${encodeURIComponent(slug)}/versions/${v.id}/thumbnail`,
          { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: blob },
        )
      } catch (err) {
        // A thumbnail upload failure does not invalidate the version itself.
        console.error('[canvas-page] auto-version thumbnail upload failed:', err)
      }
    },
  })
  // CanvasPage also keeps a reference to the Excalidraw API for library import work.
  // useWhiteboardSync stores the same API in its own ref on purpose because the responsibilities differ.
  const handleApiReady = (api: ExcalidrawImperativeAPI) => {
    apiRef.current = api
    onApiReady(api)
  }

  // Create a small PNG thumbnail for save flows that need one.
  // This passes getSceneElements/getAppState/getFiles through exportToBlob and returns a low-res blob.
  const getThumbnailBlob = async (): Promise<Blob | null> => {
    const api = apiRef.current
    if (!api) return null
    const elements = api.getSceneElements()
    if (elements.length === 0) return null
    const appState = api.getAppState()
    // Lower exportScale to keep the thumbnail file small. Excalidraw also supports exportPadding.
    return exportToBlob({
      elements: [...elements],
      appState: { ...appState, exportScale: 0.25 },
      files: api.getFiles(),
      exportPadding: 12,
      mimeType: 'image/png',
    })
  }

  const [canvases, setCanvases] = useState<{ slug: string; updatedAt: string }[]>([])

  // Import and restore Excalidraw libraries.
  // - On mount, fetch every server-registered library URL and merge it into the panel.
  // - If #addLibrary=URL is present, import it and persist it on the server.
  // - Clear the hash after import to avoid double-importing on reload.
  useEffect(() => {
    let cancelled = false
    const importLibrary = async (
      api: ExcalidrawImperativeAPI,
      url: string,
      openMenu: boolean,
    ): Promise<boolean> => {
      try {
        const safeUrl = getImportableLibraryUrl(url)
        if (safeUrl === null) return false
        const res = await fetch(safeUrl)
        if (!res.ok) {
          console.error('[library] fetch failed', res.status, safeUrl)
          return false
        }
        const raw = (await res.json()) as unknown
        const libraryItems = normalizeLibraryPayload(raw)
        if (libraryItems.length === 0) {
          console.warn('[library] no importable items in', safeUrl)
          return false
        }
        await api.updateLibrary({
          libraryItems: libraryItems as Parameters<ExcalidrawImperativeAPI['updateLibrary']>[0]['libraryItems'],
          openLibraryMenu: openMenu,
          merge: true,
        })
        return true
      } catch (err) {
        console.error('[library] import failed', err)
        return false
      }
    }

    const run = async () => {
      // Wait briefly if the API is not ready yet. Poll for at most 5 seconds.
      const deadline = Date.now() + 5000
      while (!apiRef.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
      }
      const api = apiRef.current
      if (cancelled || !api) return

      // 1) Restore server-registered libraries without opening the library panel.
      try {
        const res = await apiFetch(`/api/workspaces/${sessionId}/libraries`)
        if (res.ok) {
          const { urls } = (await res.json()) as { urls: string[] }
          for (const url of getInstalledLibraryUrls(urls)) {
            if (cancelled) return
            await importLibrary(api, url, false)
          }
        }
      } catch {
        /* Best effort: log failures and continue. */
      }

      // 2) Handle a new import from the URL hash, open the panel, and register it on the server.
      const libUrl = getHashLibraryUrl(window.location.hash)
      if (window.location.hash.startsWith('#addLibrary=')) {
        const clean = window.location.pathname + window.location.search
        window.history.replaceState(null, '', clean)
      }
      if (!libUrl) return
      const ok = await importLibrary(api, libUrl, true)
      if (ok) {
        // Persist the imported library on the workspace.
        try {
          await apiFetch(`/api/workspaces/${sessionId}/libraries`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: libUrl }),
          })
        } catch (err) {
          console.error('[library] register failed', err)
        }
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [sessionId, slug])

  useEffect(() => {
    let cancelled = false
    apiFetch(`/api/workspaces/${sessionId}/canvases`)
      .then((res) => res.json() as Promise<{ canvases: { slug: string; updatedAt: string }[] }>)
      .then(({ canvases }) => {
        if (cancelled) return
        setCanvases(canvases)
      })
      .catch(() => {
        /* The canvas should still work even if the header list fails to load. */
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, slug])

  // Keyboard shortcut: press "f" to toggle fullscreen, or Escape to exit it.
  // Ignore the shortcut while editing text so typing "f" does not accidentally toggle the canvas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      if (typing) return
      if (e.key === 'Escape' && isFullscreen) {
        setIsFullscreen(false)
      } else if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setIsFullscreen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isFullscreen])

  return (
    <div className="flex h-screen w-screen flex-col">
      {!isFullscreen && (
        <>
          <WorkspaceTopBar
            sessionId={sessionId}
            slug={slug}
            canvases={canvases}
            onRestored={clearLocalUndo}
            onEnterFullscreen={() => setIsFullscreen(true)}
            getThumbnailBlob={getThumbnailBlob}
          />
          {/* Show the banner only when the current HEAD is not main and still has unmerged commits. */}
          <HeaderBranchBanner sessionId={sessionId} slug={slug} />
        </>
      )}
      <main className="relative flex-1">
        <Excalidraw
          key={`${sessionId}/${slug}`}
          excalidrawAPI={handleApiReady}
          {...(typeof window !== 'undefined'
            ? { libraryReturnUrl: window.location.origin + window.location.pathname }
            : {})}
          onChange={(elements: readonly ExcalidrawElement[], _appState: AppState, files: BinaryFiles) =>
            onSceneChange?.([...elements], files)
          }
        />
        {isFullscreen && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsFullscreen(false)}
            title="Exit fullscreen (Esc / f)"
            className="absolute top-3 right-3 z-10 bg-background/95 shadow-sm"
          >
            <Minimize2 className="size-3.5" />
            Exit fullscreen
          </Button>
        )}
        {restoreInProgress && (
          // Soft-lock the canvas during restore by intercepting pointer events on a top-level overlay.
          // This is usually visible for less than a second until restore_complete arrives.
          <div className="absolute inset-0 z-50 bg-background/70 backdrop-blur-sm flex items-center justify-center">
            <div className="bg-background rounded-lg border shadow-lg px-5 py-4 flex items-center gap-3">
              <RotateCcw className="size-4 animate-spin text-primary" />
              <div className="text-sm">
                <div className="font-medium">Restoring version…</div>
                {restoreLabel && (
                  <div className="text-xs text-muted-foreground mt-0.5 truncate max-w-[18rem]">
                    {restoreLabel}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {/* Overlay that highlights new and conflicting elements for a short time after merge. */}
        <MergeHighlight sessionId={sessionId} slug={slug} apiRef={apiRef} />
      </main>
      {/* Merge success toast with undo support, driven by excalidraw:merge_committed events. */}
      <MergeToast sessionId={sessionId} slug={slug} onRestored={clearLocalUndo} />
    </div>
  )
}
