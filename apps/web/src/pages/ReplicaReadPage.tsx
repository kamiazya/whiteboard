/**
 * ADR-0023's offline read: the daemon that keeps this workspace is
 * unreachable, and this browser holds a replica of it — so reads are served
 * from the replica, read-only by construction. Every renderer here takes a
 * VALUE (a document list, a markdown string, a SpatialCanvas), none can
 * write; the record is opened with `open`, never `create`, so a missing
 * replica stays missing instead of being minted. Control-plane actions need
 * the keeper (decision 3), so none are offered — not greyed out, absent.
 *
 * A lazy page like the others: it imports loro-adapter and the canvas
 * viewer, which must stay out of the entry closure
 * (entry-graph-loro-free.test.ts).
 */
import { CanvasViewer, createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import {
  documentContainers,
  readMarkdownBody,
  readSpatialCanvas,
  readWorkspaceDocuments,
} from '@kamiazya/whiteboard-loro-adapter'
import type { LoroDoc } from 'loro-crdt'
import { useEffect, useMemo, useState } from 'react'
import { PreviewPane } from '../components/markdown-editor/PreviewPane.js'
import type { WorkspaceDocumentEntry } from '../components/workspace-files/document-entry.js'
import { WorkspaceFileTree } from '../components/workspace-files/WorkspaceFileTree.js'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'

export interface ReplicaReadPageProps {
  /** The daemon workspace's canonical id — the replica registry's key. */
  workspaceId: string
  displayName?: string
  /** When the replica was last synced, from the registry entry. */
  syncedAt: string
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'ready'; record: LoroDoc; entries: WorkspaceDocumentEntry[] }

export function ReplicaReadPage({ workspaceId, displayName, syncedAt }: ReplicaReadPageProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const measure = useMemo(() => createBrowserMeasureText(), [])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // `open`, never `create`: a replica the registry promises but the store
    // lost must render as missing, not be minted empty — an empty record
    // under the daemon's id would read as the daemon's data being gone.
    void new BrowserWorkspaceDocs()
      .open(workspaceId)
      .then((record) => {
        if (cancelled) return
        if (record === null) {
          setState({ kind: 'missing' })
          return
        }
        // Re-shaped into the web entry type: the two agree except that
        // loro-adapter's updatedAt is a number, and this page has no use
        // for a timestamp the banner already states better.
        const entries = readWorkspaceDocuments(record).map(
          ({ documentId, path, kind, name, shadowed }): WorkspaceDocumentEntry => ({
            documentId,
            path,
            ...(kind === undefined ? {} : { kind }),
            ...(name === undefined ? {} : { name }),
            ...(shadowed === undefined ? {} : { shadowed }),
          }),
        )
        setState({ kind: 'ready', record, entries })
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'missing' })
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const selected =
    state.kind === 'ready' && selectedPath !== null
      ? state.entries.find((entry) => entry.path === selectedPath)
      : undefined

  const content = useMemo(() => {
    if (state.kind !== 'ready' || selected === undefined) return null
    const containers = documentContainers(state.record, selected.documentId)
    return selected.kind === 'spatial'
      ? { kind: 'spatial' as const, canvas: readSpatialCanvas(containers) }
      : { kind: 'markdown' as const, body: readMarkdownBody(containers) }
  }, [state, selected])

  return (
    <div className="flex h-full flex-col" data-testid="replica-read-page">
      <div
        data-testid="replica-offline-banner"
        className="border-b bg-amber-500/10 px-4 py-2 text-sm"
      >
        <span className="font-medium">{displayName ?? workspaceId}</span>
        {' — the daemon that keeps this workspace is unreachable. '}
        Reading the copy cached in this browser (synced {new Date(syncedAt).toLocaleString()}),
        read-only.
      </div>
      {state.kind === 'loading' && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
      {state.kind === 'missing' && (
        <p className="p-4 text-sm text-muted-foreground" data-testid="replica-missing">
          No cached copy of this workspace is stored in this browser.
        </p>
      )}
      {state.kind === 'ready' && (
        <div className="flex min-h-0 flex-1">
          <div className="w-64 shrink-0 overflow-y-auto border-r p-2">
            <WorkspaceFileTree
              documents={state.entries}
              onOpen={(entry) => setSelectedPath(entry.path)}
              {...(selectedPath === null ? {} : { selectedPath })}
            />
          </div>
          <div className="min-w-0 flex-1 overflow-auto p-4">
            {content === null && (
              <p className="text-sm text-muted-foreground">Select a document to read.</p>
            )}
            {content?.kind === 'markdown' && (
              <PreviewPane value={content.body} measure={measure} maxWidth={720} />
            )}
            {content?.kind === 'spatial' && (
              <CanvasViewer
                canvas={content.canvas}
                label={selected === undefined ? undefined : (selected.name ?? selected.path)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
