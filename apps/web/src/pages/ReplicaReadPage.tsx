/**
 * ADR-0023's offline page: the daemon that keeps this workspace is
 * unreachable, and this browser holds a replica of it. Markdown bodies are
 * EDITABLE — decision 3's data plane: the edits are CRDT ops appended to
 * the replica record and shipped to the daemon as ordinary updates when it
 * returns (replica-push, run by the daemon page's resolve effect). Spatial
 * documents stay read-only for now; the convergence argument is identical,
 * only the editor mount is heavier. Control-plane actions need the keeper
 * (decision 3), so none are offered — not greyed out, absent — and NOTHING
 * here may touch a document index: a data-plane edit writes the record and
 * only the record. The record is opened with `open`, never `create`, so a
 * missing replica stays missing instead of being minted.
 *
 * A lazy page like the others: it imports loro-adapter and the canvas
 * viewer, which must stay out of the entry closure
 * (entry-graph-loro-free.test.ts).
 */

import {
  documentContainers,
  readMarkdownBody,
  readSpatialCanvas,
  readWorkspaceDocuments,
  reconcileSpatialCanvas,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownEditor } from '../components/markdown-editor/MarkdownEditor.js'
import { SpatialEditor } from '../components/spatial-editor/SpatialEditor.js'
import { formatRelative } from '../components/workspace-files/format-relative.js'
import { WorkspaceFileTree } from '../components/workspace-files/WorkspaceFileTree.js'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import type { WorkspaceDocumentEntry } from '../lib/document-entry.js'

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
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  // The markdown editor's controlled value, re-derived when the selection
  // changes; edits go straight into the record's containers and a debounced
  // save appends them to the stored replica.
  const [draft, setDraft] = useState<string | null>(null)
  // ponytail: one trailing 500ms debounce + a sequential save chain — the
  // full save-scheduler carries persistence-state reporting this page does
  // not show. Upgrade path: thread createSaveScheduler when a save
  // indicator arrives here.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveChain = useRef<Promise<void>>(Promise.resolve())
  const saveNow = useCallback(
    (record: LoroDoc) => {
      saveChain.current = saveChain.current
        .then(() => new BrowserWorkspaceDocs().save(workspaceId, record))
        .then(() => undefined)
        .catch(() => {
          // A failed append leaves the previous stored state; the ops are
          // still in the in-memory record and the next save retries them.
        })
    },
    [workspaceId],
  )
  const scheduleSave = useCallback(
    (record: LoroDoc) => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null
        saveNow(record)
      }, 500)
    },
    [saveNow],
  )
  // FLUSH on unmount, not cancel: the daemon returning is exactly what
  // unmounts this page, and that moment must not eat the last debounce
  // window of typing.
  const latestRecord = useRef<LoroDoc | null>(null)
  useEffect(() => {
    return () => {
      if (saveTimer.current !== null) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
        if (latestRecord.current !== null) saveNow(latestRecord.current)
      }
    }
  }, [saveNow])

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

  useEffect(() => {
    latestRecord.current = state.kind === 'ready' ? state.record : null
  }, [state])

  const content = useMemo(() => {
    if (state.kind !== 'ready' || selected === undefined) return null
    const containers = documentContainers(state.record, selected.documentId)
    return selected.kind === 'spatial'
      ? { kind: 'spatial' as const, canvas: readSpatialCanvas(containers) }
      : { kind: 'markdown' as const, body: readMarkdownBody(containers) }
  }, [state, selected])

  // Selection decides the draft; the record is the source on every switch.
  useEffect(() => {
    setDraft(content?.kind === 'markdown' ? content.body : null)
    spatialPrev.current = content?.kind === 'spatial' ? content.canvas : null
    setSpatialDraft(content?.kind === 'spatial' ? content.canvas : null)
  }, [content])

  // The spatial draft mirrors the markdown one; `spatialPrev` is what the
  // visible-diff reconcile compares against, advanced on every commit.
  const [spatialDraft, setSpatialDraft] = useState<SpatialCanvas | null>(null)
  const spatialPrev = useRef<SpatialCanvas | null>(null)
  const onSpatialChange = useCallback(
    (next: SpatialCanvas) => {
      if (state.kind !== 'ready' || selected === undefined || selected.kind !== 'spatial') return
      setSpatialDraft(next)
      const prev = spatialPrev.current
      if (prev !== null) {
        // A visible diff, never a whole-canvas resync: a resync's silent
        // deletion of an unknown-version record would become an op that
        // SHIPS, erasing a newer client's node on the keeper.
        reconcileSpatialCanvas(documentContainers(state.record, selected.documentId), prev, next)
      }
      spatialPrev.current = next
      scheduleSave(state.record)
    },
    [state, selected, scheduleSave],
  )

  const onDraftChange = useCallback(
    (next: string) => {
      if (state.kind !== 'ready' || selected === undefined || selected.kind === 'spatial') return
      setDraft(next)
      writeMarkdownBody(documentContainers(state.record, selected.documentId), next)
      scheduleSave(state.record)
    },
    [state, selected, scheduleSave],
  )

  return (
    <div className="flex h-full flex-col" data-testid="replica-read-page">
      <div
        data-testid="replica-offline-banner"
        className="border-b bg-amber-500/10 px-4 py-2 text-sm"
      >
        <span className="font-medium">{displayName ?? workspaceId}</span>
        {' — the daemon that keeps this workspace is unreachable. '}
        This is the copy cached in this browser (synced{' '}
        {formatRelative(syncedAt, { pastDay: 'absolute' })}). Edits save here and ship to the daemon
        when it returns.
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
          <div
            className={
              // The spatial editor measures itself: inside a padded
              // overflow-auto box its h-full slightly overflows, a scrollbar
              // appears, the box shrinks, the scrollbar leaves — a
              // ResizeObserver oscillation React reports as "maximum update
              // depth exceeded". Text content keeps the scrolling pane.
              content?.kind === 'spatial'
                ? 'min-w-0 flex-1 overflow-hidden'
                : 'min-w-0 flex-1 overflow-auto p-4'
            }
          >
            {content === null && (
              <p className="text-sm text-muted-foreground">Select a document to read.</p>
            )}
            {content?.kind === 'markdown' && draft !== null && (
              <MarkdownEditor
                key={selected?.documentId}
                initialViewMode="split"
                value={draft}
                onChange={onDraftChange}
              />
            )}
            {content?.kind === 'spatial' && spatialDraft !== null && (
              <SpatialEditor
                key={selected?.documentId}
                canvas={spatialDraft}
                onChange={onSpatialChange}
                // Editing-forward: the palette still offers the hand tool,
                // but an offline visit that came here to fix something
                // should not need a tool switch first.
                defaultTool="select"
                className="h-full"
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
