import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { useEffect, useState } from 'react'
import { getAppLogger } from '../../lib/app-logger.js'
import { DEFAULT_DAEMON_BASE_URL } from '../../lib/daemon-probe.js'
import { type ContentClock, listLocalDocuments } from '../../lib/local-document-summary.js'
import type { LoroLoadResult } from '../../lib/loro-store.js'
import type { UserSettingsStore } from '../../lib/user-settings-store.js'
import type { DocumentSnapshot } from '../../lib/whiteboard-client.js'
import { importOneDocument } from './import-browser-local.js'

const log = getAppLogger('import-browser-local-panel')

// Minimal surface this panel needs from LoroStore — narrower than the full
// class so tests can inject a plain object instead of touching IndexedDB.
interface ImportLoroStoreLike {
  load(documentId: string): Promise<LoroLoadResult>
}

interface ImportBrowserLocalPanelProps {
  workspaceId: string
  daemonFetch: typeof globalThis.fetch
  daemonBaseUrl?: string
  browserLocalStore: DocumentIndex
  /** Last-edited times, which the index does not hold. Injected for the same
   *  reason the store is: it reads IndexedDB, and a jsdom test has none. */
  browserLocalClock?: ContentClock
  loroStore: ImportLoroStoreLike
  settingsStore: UserSettingsStore
}

type RowResult =
  | { status: 'pending' }
  | { status: 'success'; path: string }
  | { status: 'error'; reason: string }

/**
 * Copy-first migration UI: lists browser-local documents and imports selected
 * ones onto a paired daemon workspace one at a time (sequential, not
 * Promise.all, to bound peak memory while merging large Loro histories).
 * Never writes to or deletes from browserLocalStore/loroStore.
 */
export function ImportBrowserLocalPanel({
  workspaceId,
  daemonFetch,
  daemonBaseUrl = DEFAULT_DAEMON_BASE_URL,
  browserLocalStore,
  browserLocalClock,
  loroStore,
  settingsStore,
}: ImportBrowserLocalPanelProps) {
  const [documents, setDocuments] = useState<DocumentSnapshot[] | null>(null)
  const [results, setResults] = useState<Record<string, RowResult>>({})
  const [isImporting, setIsImporting] = useState(false)

  useEffect(() => {
    let cancelled = false
    listLocalDocuments(browserLocalStore, browserLocalClock)
      .then((list) => {
        if (!cancelled) setDocuments(list)
      })
      .catch((err: unknown) => {
        // A blocked/corrupt IndexedDB must not leave the panel in the
        // loading state forever — degrade to the empty state.
        log.error('listDocuments failed', err)
        if (!cancelled) setDocuments([])
      })
    return () => {
      cancelled = true
    }
  }, [browserLocalStore, browserLocalClock])

  async function handleImport() {
    if (!documents || documents.length === 0) return
    setIsImporting(true)
    let anySuccess = false
    let lastSuccessCanvasId: string | undefined

    try {
      // Sequential on purpose: each iteration merges a full Loro history into
      // a throwaway doc, which is memory-heavy for large documents.
      for (const canvas of documents) {
        setResults((prev) => ({ ...prev, [canvas.documentId]: { status: 'pending' } }))
        try {
          const loroLoad = await loroStore.load(canvas.documentId)
          const result = await importOneDocument({
            fetch: daemonFetch,
            daemonBaseUrl,
            workspaceId,
            documentPath: canvas.path,
            documentKind: canvas.kind,
            loroLoad,
          })
          if (result.kind === 'ok') {
            anySuccess = true
            lastSuccessCanvasId = canvas.documentId
            setResults((prev) => ({
              ...prev,
              [canvas.documentId]: { status: 'success', path: result.path },
            }))
          } else {
            setResults((prev) => ({
              ...prev,
              [canvas.documentId]: { status: 'error', reason: result.reason },
            }))
          }
        } catch {
          // One canvas throwing (IndexedDB read failure, unexpected error)
          // must not abort the rest of the batch.
          setResults((prev) => ({
            ...prev,
            [canvas.documentId]: {
              status: 'error',
              reason: 'Could not read this canvas from the browser.',
            },
          }))
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
              lastImportedDocumentId: lastSuccessCanvasId,
            },
          },
        }))
      }
    } finally {
      // The import button must never stay disabled after a failed batch.
      setIsImporting(false)
    }
  }

  if (documents === null) {
    return <p className="text-sm text-muted-foreground">Loading browser-local documents…</p>
  }

  if (documents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No browser-local documents to import on this device.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {documents.map((canvas) => {
          const result = results[canvas.documentId]
          return (
            <li key={canvas.documentId} className="flex items-center justify-between gap-2 text-sm">
              <span>{canvas.name}</span>
              {result?.status === 'success' && (
                <span className="text-xs text-muted-foreground">{`Imported as ${result.path}`}</span>
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
