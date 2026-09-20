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
  type LoadedReference,
  type ReferenceWire,
  referenceSeamsFromWire,
  referenceTargets,
  referenceWire,
} from '@kamiazya/whiteboard-canvas-render'
import { createUniqueNameResolver } from '@kamiazya/whiteboard-codec'
import type { WithheldReason } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
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
import { type LinkableDocument, linkEntries, linkTitles } from '../lib/link-entries.js'
import type { ReplicaKeyInput, ReplicaRenewalInput } from '../lib/replica-page-state.js'
import { replicaPageState } from '../lib/replica-page-state.js'
import { lockedDetail, REPLICA_STATE_COPY } from '../lib/replica-state-copy.js'
import { forgetDaemonKeys, replicaKeyStatus } from '../lib/replica-store.js'
import { ReplicaKeyWithheldError } from '../lib/sealed-document-store.js'

export interface ReplicaReadPageProps {
  /** The daemon workspace's canonical id — the replica registry's key. */
  workspaceId: string
  displayName?: string
  /** When the replica was last synced, from the registry entry. */
  syncedAt: string
  /** The daemon this replica belongs to — what a Reconnect forgets keys for. */
  daemonBaseUrl: string
  /** What App's silent renewal answered: reached-and-refused, or not reached at all (ADR-0042 decisions 3-5). */
  renewal: ReplicaRenewalInput
  /** Re-runs App's renewal (and, through it, the key ask) — the Reconnect action. */
  onReconnect: () => void | Promise<void>
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'withheld'; reason: WithheldReason }
  | { kind: 'ready'; record: LoroDoc; entries: WorkspaceDocumentEntry[] }

function keyInputFor(state: LoadState): ReplicaKeyInput {
  if (state.kind === 'withheld') return { withheld: state.reason }
  if (state.kind === 'ready') return 'readable'
  return 'missing'
}

export function ReplicaReadPage({
  workspaceId,
  displayName,
  syncedAt,
  daemonBaseUrl,
  renewal,
  onReconnect,
}: ReplicaReadPageProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  // Bumped by Reconnect to re-run the load effect below without touching
  // `workspaceId` — a forget()+re-ask must go through the SAME open() path
  // a cold load takes, never a bespoke retry.
  const [attempt, setAttempt] = useState(0)
  const [reconnecting, setReconnecting] = useState(false)
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
    setState({ kind: 'loading' })
    // Read BEFORE the open, not only after: a lapsed entry is what
    // `open()` itself will discover (`sessionKey`'s own lapse check runs
    // inside the store's `keyFor`), and that check CLEARS the cache entry
    // the moment it fires — so a status read taken only in the catch below
    // would already find nothing and report 'unreachable', losing the one
    // reason the lapsed state exists to show. The two never disagree when
    // both are defined; this one is only load-bearing for a reason that
    // vanishes between the two reads.
    const precheck = replicaKeyStatus(daemonBaseUrl, workspaceId)
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
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ReplicaKeyWithheldError) {
          // Read the holder's cached reason rather than believing 'unreachable'
          // by default — the whole point of S5 is that a daemon-refused key
          // reads as removed, not as an ordinary disconnection.
          const status = replicaKeyStatus(daemonBaseUrl, workspaceId)
          const reason =
            status?.kind === 'withheld'
              ? status.reason
              : precheck?.kind === 'withheld'
                ? precheck.reason
                : 'unreachable'
          setState({ kind: 'withheld', reason })
          return
        }
        setState({ kind: 'missing' })
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, daemonBaseUrl, attempt])

  const pageState =
    state.kind === 'loading' ? null : replicaPageState({ renewal, key: keyInputFor(state) })

  // forget-then-ask (ADR-0042's own reconnect contract, S4a): the S5 spec's
  // failure mode is a stale cached `withheld:'unreachable'` outliving a
  // Reconnect click, and `forget` is what clears it before the new ask.
  const handleReconnect = useCallback(async () => {
    if (reconnecting) return
    setReconnecting(true)
    try {
      forgetDaemonKeys(daemonBaseUrl)
      await onReconnect()
      setAttempt((a) => a + 1)
    } finally {
      setReconnecting(false)
    }
  }, [daemonBaseUrl, onReconnect, reconnecting])

  const selected =
    state.kind === 'ready' && selectedPath !== null
      ? state.entries.find((entry) => entry.path === selectedPath)
      : undefined

  useEffect(() => {
    latestRecord.current = state.kind === 'ready' ? state.record : null
  }, [state])

  // What the selected document points at, answered from the replica record
  // itself. Nothing here reaches a keeper: the alias table is the record's
  // own entries, and every target's body or canvas is read from the same
  // record through `documentContainers`. That is what makes references work
  // on the one page that exists BECAUSE the daemon is unreachable — and it
  // stays inside the page's own rule, since reading a container is not an
  // index write.
  // The same two tables both keeper pages build, over this record's own
  // entries — so a `[[...]]` written here resolves by the rules the rest of
  // the app already applies (path or id; a display name is a label, never a
  // target) rather than by a lookup this page invented for itself.
  const linkable = useMemo(
    (): readonly LinkableDocument[] =>
      state.kind === 'ready'
        ? state.entries.map((entry) => ({
            id: entry.documentId,
            path: entry.path,
            ...(entry.name === undefined ? {} : { displayName: entry.name }),
            ...(entry.kind === undefined ? {} : { kind: entry.kind }),
          }))
        : [],
    [state],
  )
  const resolveAlias = useMemo(() => createUniqueNameResolver(linkEntries(linkable)), [linkable])
  const resolveTitle = useMemo(() => linkTitles(linkable), [linkable])

  const references = useMemo((): ReferenceWire | undefined => {
    if (state.kind !== 'ready' || selected === undefined) return undefined
    const byId = new Map(state.entries.map((entry) => [entry.documentId, entry]))
    const load = (target: string): LoadedReference | null => {
      const entry = byId.get(resolveAlias(target) ?? target) ?? byId.get(target)
      if (entry === undefined) return null
      const containers = documentContainers(state.record, entry.documentId)
      return {
        documentId: entry.documentId,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        ...(entry.kind === 'spatial'
          ? { canvas: readSpatialCanvas(containers) }
          : { body: readMarkdownBody(containers) }),
      }
    }
    // Seeded from what the SELECTED document says, then walked the way every
    // other keeper walks it — `referenceTargets` re-reads the graph as it
    // grows, so a referenced body's own links load too, under its own caps.
    const containers = documentContainers(state.record, selected.documentId)
    const seeds =
      selected.kind === 'spatial'
        ? { canvases: [readSpatialCanvas(containers)] }
        : { bodies: [readMarkdownBody(containers)] }
    const graph = new Map<string, LoadedReference | null>()
    for (;;) {
      const wanted = referenceTargets({ ...seeds, loaded: graph }).filter(
        (target) => !graph.has(target),
      )
      if (wanted.length === 0) break
      for (const target of wanted) graph.set(target, load(target))
    }
    return referenceWire(graph, { resolveAlias, resolveTitle })
  }, [state, selected, resolveAlias, resolveTitle])

  const seams = useMemo(
    () => (references === undefined ? undefined : referenceSeamsFromWire(references)),
    [references],
  )

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

  const lockedLine = state.kind === 'withheld' ? lockedDetail(state.reason) : undefined

  // Mounted before it speaks (polite-live-region.test.ts): a role="status"
  // region that arrives already carrying its message is announced
  // inconsistently, so this ONE region stays in the DOM for the page's whole
  // life and only its text changes — sr-only when there is nothing to say,
  // since the visible copy below says the same thing for a sighted reader.
  // 'locked' and 'needs-connection' both render NOTHING but a connectivity
  // message, so a screen-reader user landing there (first mount, or after a
  // Reconnect attempt that settles back) must hear it — not just 'Loading…'
  // followed by silence.
  const liveStatus =
    state.kind === 'loading'
      ? 'Loading…'
      : reconnecting
        ? 'Reconnecting…'
        : pageState === 'removed' || pageState === 'unpaired'
          ? REPLICA_STATE_COPY[pageState].body
          : pageState === 'locked' || pageState === 'needs-connection'
            ? REPLICA_STATE_COPY[pageState].body + (lockedLine ? ` ${lockedLine}` : '')
            : null

  return (
    <div className="flex h-full flex-col" data-testid="replica-read-page">
      <p role="status" aria-live="polite" data-testid="replica-live-status" className="sr-only">
        {liveStatus ?? ''}
      </p>
      {state.kind === 'loading' && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
      {pageState === 'readable' && state.kind === 'ready' && (
        <div className="flex h-full flex-col" data-testid="replica-state-readable">
          <div
            data-testid="replica-offline-banner"
            className="border-b bg-amber-500/10 px-4 py-2 text-sm"
          >
            <span className="font-medium">{displayName ?? workspaceId}</span>
            {' — the daemon that keeps this workspace is unreachable. '}
            This is the copy cached in this browser (synced{' '}
            {formatRelative(syncedAt, { pastDay: 'absolute' })}). Edits save here and ship to the
            daemon when it returns.
          </div>
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
                  references={seams}
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
                  references={references}
                />
              )}
            </div>
          </div>
        </div>
      )}
      {(pageState === 'needs-connection' || pageState === 'locked') && (
        <div
          className="p-4 text-sm text-muted-foreground"
          data-testid={`replica-state-${pageState}`}
        >
          <p>
            {REPLICA_STATE_COPY[pageState].body}
            {lockedLine && ` ${lockedLine}`}
          </p>
          <button type="button" aria-disabled={reconnecting} onClick={() => void handleReconnect()}>
            {REPLICA_STATE_COPY[pageState].action}
          </button>
          {reconnecting && (
            <p className="mt-2" data-testid="replica-reconnecting-line">
              Reconnecting…
            </p>
          )}
        </div>
      )}
      {(pageState === 'removed' || pageState === 'unpaired') && (
        <p className="p-4 text-sm text-muted-foreground" data-testid={`replica-state-${pageState}`}>
          {REPLICA_STATE_COPY[pageState].body}
        </p>
      )}
    </div>
  )
}
