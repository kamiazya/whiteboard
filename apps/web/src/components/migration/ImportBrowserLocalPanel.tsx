import { useEffect, useState } from 'react'
import { DEFAULT_DAEMON_BASE_URL } from '../../lib/daemon-probe.js'
import type { BrowserLocalStore } from '../../lib/browser-local-store.js'
import type { LoroLoadResult } from '../../lib/loro-store.js'
import type { UserSettingsStore } from '../../lib/user-settings-store.js'
import type { CanvasSnapshot } from '../../lib/whiteboard-client.js'
import { importOneCanvas } from './import-browser-local.js'

// Minimal surface this panel needs from LoroStore — narrower than the full
// class so tests can inject a plain object instead of touching IndexedDB.
export interface ImportLoroStoreLike {
  load(canvasId: string): Promise<LoroLoadResult>
}

interface ImportBrowserLocalPanelProps {
  workspaceId: string
  daemonFetch: typeof globalThis.fetch
  daemonBaseUrl?: string
  browserLocalStore: BrowserLocalStore
  loroStore: ImportLoroStoreLike
  settingsStore: UserSettingsStore
}

type RowResult =
  | { status: 'pending' }
  | { status: 'success'; slug: string }
  | { status: 'error'; reason: string }

/**
 * Copy-first migration UI: lists browser-local canvases and imports selected
 * ones onto a paired daemon workspace one at a time (sequential, not
 * Promise.all, to bound peak memory while merging large Loro histories).
 * Never writes to or deletes from browserLocalStore/loroStore.
 */
export function ImportBrowserLocalPanel({
  workspaceId,
  daemonFetch,
  daemonBaseUrl = DEFAULT_DAEMON_BASE_URL,
  browserLocalStore,
  loroStore,
  settingsStore,
}: ImportBrowserLocalPanelProps) {
  const [canvases, setCanvases] = useState<CanvasSnapshot[] | null>(null)
  const [results, setResults] = useState<Record<string, RowResult>>({})
  const [isImporting, setIsImporting] = useState(false)

  useEffect(() => {
    let cancelled = false
    browserLocalStore.listCanvases().then((list) => {
      if (!cancelled) setCanvases(list)
    })
    return () => {
      cancelled = true
    }
  }, [browserLocalStore])

  async function handleImport() {
    if (!canvases || canvases.length === 0) return
    setIsImporting(true)
    let anySuccess = false
    let lastSuccessCanvasId: string | undefined

    // Sequential on purpose: each iteration merges a full Loro history into
    // a throwaway doc, which is memory-heavy for large canvases.
    for (const canvas of canvases) {
      setResults((prev) => ({ ...prev, [canvas.id]: { status: 'pending' } }))
      const loroLoad = await loroStore.load(canvas.id)
      const result = await importOneCanvas({
        fetch: daemonFetch,
        daemonBaseUrl,
        workspaceId,
        canvasName: canvas.name,
        loroLoad,
      })
      if (result.kind === 'ok') {
        anySuccess = true
        lastSuccessCanvasId = canvas.id
        setResults((prev) => ({ ...prev, [canvas.id]: { status: 'success', slug: result.slug } }))
      } else {
        setResults((prev) => ({ ...prev, [canvas.id]: { status: 'error', reason: result.reason } }))
      }
    }

    if (anySuccess) {
      const now = new Date().toISOString()
      settingsStore.update((current) => ({
        ...current,
        migration: {
          ...current.migration,
          browserLocalToDaemon: {
            ...current.migration.browserLocalToDaemon,
            lastImportedAt: now,
            lastImportedCanvasId: lastSuccessCanvasId,
          },
        },
      }))
    }

    setIsImporting(false)
  }

  if (canvases === null) {
    return <p className="text-sm text-muted-foreground">Loading browser-local canvases…</p>
  }

  if (canvases.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No browser-local canvases to import on this device.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {canvases.map((canvas) => {
          const result = results[canvas.id]
          return (
            <li key={canvas.id} className="flex items-center justify-between gap-2 text-sm">
              <span>{canvas.name}</span>
              {result?.status === 'success' && (
                <span className="text-xs text-muted-foreground">{`Imported as ${result.slug}`}</span>
              )}
              {result?.status === 'error' && (
                <span className="text-xs text-destructive">{result.reason}</span>
              )}
              {result?.status === 'pending' && (
                <span className="text-xs text-muted-foreground">Importing…</span>
              )}
            </li>
          )
        })}
      </ul>
      <button
        type="button"
        onClick={() => void handleImport()}
        disabled={isImporting}
        className="w-fit rounded-md border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        Import
      </button>
    </div>
  )
}
