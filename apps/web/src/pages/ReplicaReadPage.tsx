/**
 * ADR-0023's offline page: the daemon that keeps this workspace is
 * unreachable, and this browser holds a replica of it. Markdown bodies and
 * canvases are EDITABLE — decision 3's data plane: the edits are CRDT ops
 * appended to the replica record and shipped to the daemon as ordinary
 * updates when it returns (replica-push, run by the daemon page's resolve
 * effect). Control-plane actions need the keeper
 * (decision 3), so none are offered — not greyed out, absent — and NOTHING
 * here may touch a document index: a data-plane edit writes the record and
 * only the record. The record is opened with `open`, never `create`, so a
 * missing replica stays missing instead of being minted.
 *
 * A lazy page like the others: it reaches loro through `lib/replica-record`
 * and the canvas viewer through its editors, which must stay out of the
 * entry closure (entry-graph-loro-free.test.ts). No module under `pages/`
 * names the CRDT itself (pages-loro-free.test.ts).
 *
 * ponytail: this is a document-editing surface outside the keeper seam
 * (ADR-0004: one page, a keeper per mode) — it mounts the editors itself and
 * saves through its own queue. Routing it through the shared page needs a
 * replica keeper whose backend (a) opens with `open` and never places a
 * node: `BrowserBackend` runs the startup fold and creates a missing node,
 * both index writes this page must not make; (b) addresses the record by the
 * daemon's workspace id, where `BrowserBackend` calls
 * `getBrowserWorkspaceId()`; and (c) answers the page model with every
 * control-plane action ABSENT rather than refused, over a model that has
 * dozens of members. Upgrade path: a replica backend and keeper, then the
 * replica fixture in `test-utils/document-page.contract.tsx`; until then
 * this page's own tests are the only run of the shared scenarios.
 */

import { type ReferenceWire, referenceSeamsFromWire } from '@kamiazya/whiteboard-canvas-render'
import { createUniqueNameResolver } from '@kamiazya/whiteboard-codec'
import type { WithheldReason } from '@kamiazya/whiteboard-daemon-client/replica-session-key'
import { type FacetRegistry, withWorkspaceStencils } from '@kamiazya/whiteboard-facet-engine'
import { imageRefId, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import { bundledFacetRegistry, type TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { MarkdownEditor } from '../components/markdown-editor/MarkdownEditor.js'
import { SpatialEditor } from '../components/spatial-editor/SpatialEditor.js'
import { Button } from '../components/ui/button.js'
import { WorkspaceFileTree } from '../components/workspace-files/WorkspaceFileTree.js'
import { TRANSIENT_LOAD_ATTEMPTS } from '../hooks/use-prefetched-cache.js'
import { useReplicaEditing } from '../hooks/use-replica-editing.js'
import { useReplicaSaveQueue } from '../hooks/use-replica-save-queue.js'
import { useThemeMode } from '../hooks/useThemeMode.js'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import type { ClipboardImageSeams } from '../lib/clipboard-images.js'
import type { WorkspaceDocumentEntry } from '../lib/document-entry.js'
import { formatRelative } from '../lib/format-relative.js'
import { type LinkableDocument, linkEntries, linkTargets, linkTitles } from '../lib/link-entries.js'
import { replicaClipboardImages } from '../lib/replica-clipboard-images.js'
import { loadReplicaImagesRetrying } from '../lib/replica-images.js'
import type { ReplicaKeyInput } from '../lib/replica-page-state.js'
import { type ReplicaPageState, replicaPageState } from '../lib/replica-page-state.js'
import {
  type ReplicaContent,
  type ReplicaRecord,
  replicaEntries,
  replicaReferenceGraph,
  replicaReferenceWire,
  replicaStencilLibrary,
  replicaTagLibrary,
  replicaTagsInUse,
} from '../lib/replica-record.js'
import {
  lockedDetail,
  REPLICA_COPY_REMOVED_COPY,
  REPLICA_SAVE_FAILED_COPY,
  REPLICA_STATE_COPY,
} from '../lib/replica-state-copy.js'
import { forgetDaemonKeys, replicaKeyStatus } from '../lib/replica-store.js'
import { isReplicaReadableOffline, unlockReplicaKey } from '../lib/replica-unlock.js'
import { ReplicaKeyRotatedError, ReplicaKeyWithheldError } from '../lib/sealed-document-store.js'
import { setShellConnection } from '../lib/shell-status-store.js'
import { workspaceLabel } from '../lib/workspace-handle.js'

export interface ReplicaReadPageProps {
  /** The daemon workspace's canonical id — the replica registry's key. */
  workspaceId: string
  /** What names it in the banner, through `workspaceLabel`'s precedence. */
  segment?: string
  displayName?: string
  /** When the replica was last synced, from the registry entry. Absent when
   *  the page is mounted directly for a live-daemon refusal rather than for
   *  an actual offline replica — only the readable banner's "(synced …)"
   *  clause reads it. */
  syncedAt?: string
  /** The daemon this replica belongs to — what a Reconnect forgets keys for. */
  daemonBaseUrl: string
  /**
   * A membership refusal the DAEMON already answered directly (not from the
   * replica-key holder), so the page never opens the replica record at all
   * — a removed member with no replica record on this device would
   * otherwise read as 'needs-connection' rather than 'removed'.
   */
  withheld?: WithheldReason
  /** Re-runs App's renewal (and, through it, the key ask) — the Reconnect action. */
  onReconnect: () => void | Promise<void>
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'rotated' }
  | { kind: 'withheld'; reason: WithheldReason }
  | { kind: 'ready'; record: ReplicaRecord; entries: WorkspaceDocumentEntry[] }

function keyInputFor(state: LoadState): ReplicaKeyInput {
  if (state.kind === 'withheld') return { withheld: state.reason }
  if (state.kind === 'ready') return 'readable'
  if (state.kind === 'rotated') return 'rotated'
  return 'missing'
}

/**
 * The panel every non-readable state renders: the state's sentence, its one
 * action, and a line while that action is in flight.
 *
 * One component rather than a block per state, because the three that have
 * an action ('needs-connection', 'locked', 'unlockable') differ only in
 * their copy and what the button does — and a fourth arriving as a fourth
 * near-identical block is how the first two came to drift apart in spacing.
 */
function ReplicaActionPanel({
  state,
  body,
  action,
  busy,
  busyLine,
  onAction,
}: {
  state: ReplicaPageState
  body: string
  action: string
  busy: boolean
  busyLine: string
  onAction: () => void
}) {
  return (
    <div className="p-4 text-sm text-muted-foreground" data-testid={`replica-state-${state}`}>
      <p>{body}</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-3"
        aria-disabled={busy}
        onClick={onAction}
      >
        {action}
      </Button>
      {busy && (
        <p className="mt-2" data-testid={`replica-${state}-busy-line`}>
          {busyLine}
        </p>
      )}
    </div>
  )
}

/**
 * What a failed open means. A rotated key comes first, ahead of the generic
 * arm that would call the copy missing: the bytes are there and intact, sealed
 * under a key that is gone. A withheld key reads the holder's cached reason
 * rather than believing 'unreachable' by default — the whole point of the
 * removed state is that a daemon-refused key reads as removed, not as an
 * ordinary disconnection.
 */
function loadFailureState(
  error: unknown,
  daemonBaseUrl: string,
  workspaceId: string,
  precheck: ReturnType<typeof replicaKeyStatus>,
): LoadState {
  if (error instanceof ReplicaKeyRotatedError) return { kind: 'rotated' }
  if (!(error instanceof ReplicaKeyWithheldError)) return { kind: 'missing' }
  const status = replicaKeyStatus(daemonBaseUrl, workspaceId)
  const reason =
    status?.kind === 'withheld'
      ? status.reason
      : precheck?.kind === 'withheld'
        ? precheck.reason
        : 'unreachable'
  return { kind: 'withheld', reason }
}

/**
 * Opens this workspace's stored replica and says what came back: the record
 * and its entries, a withheld reason, or nothing at all. Re-runs on an
 * `attempt` bump, which is how Reconnect and Unlock re-enter the SAME open
 * path a cold load takes rather than a bespoke retry.
 */
function useReplicaRecord({
  workspaceId,
  daemonBaseUrl,
  attempt,
  withheld,
  setState,
}: {
  workspaceId: string
  daemonBaseUrl: string
  attempt: number
  withheld: ReplicaReadPageProps['withheld']
  setState: (state: LoadState) => void
}): void {
  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    // The daemon already answered directly (a live-daemon membership
    // refusal, not a replica-key holder verdict) — never open the record at
    // all. Without this branch a removed member with no replica record on
    // this device would read as 'needs-connection' rather than 'removed'.
    if (withheld !== undefined) {
      setState({ kind: 'withheld', reason: withheld })
      return
    }
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
        const entries = replicaEntries(record)
        setState({ kind: 'ready', record, entries })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState(loadFailureState(error, daemonBaseUrl, workspaceId, precheck))
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, daemonBaseUrl, attempt, withheld])
}

/**
 * Object URLs for the cached images among `refs`, keyed by the reference as
 * written; undefined until the cache has answered for this exact set, so the
 * wire never calls a picture unavailable before it has been looked for.
 *
 * A read that fails is asked again up to `TRANSIENT_LOAD_ATTEMPTS` times
 * before the set is answered, as `useImageUrls` does online; the loader
 * never rejects, so a lookup that keeps failing still answers, with nothing
 * found, rather than leaving every picture waiting.
 */
function useReplicaImageUrls(
  workspaceId: string,
  refs: readonly string[] | undefined,
): ReadonlyMap<string, string> | undefined {
  const [loaded, setLoaded] = useState<{
    refs: readonly string[]
    urls: ReadonlyMap<string, string>
  }>()
  useEffect(() => {
    if (refs === undefined) return
    let cancelled = false
    const made: string[] = []
    void loadReplicaImagesRetrying(workspaceId, refs.map(imageRefId), {
      attempts: TRANSIENT_LOAD_ATTEMPTS,
    }).then((blobs) => {
      if (cancelled) return
      const urls = new Map<string, string>()
      for (const ref of refs) {
        const blob = blobs.get(imageRefId(ref))
        if (blob === undefined) continue
        const url = URL.createObjectURL(blob)
        made.push(url)
        urls.set(ref, url)
      }
      setLoaded({ refs, urls })
    })
    return () => {
      cancelled = true
      for (const url of made) URL.revokeObjectURL(url)
    }
  }, [workspaceId, refs])
  return loaded !== undefined && loaded.refs === refs ? loaded.urls : undefined
}

/**
 * The replica's own link tables — the ones both keeper pages build, over this
 * record's entries — and how a followed link opens its target here.
 *
 * A resolved wiki link's anchor carries a bare document id as its href, so a
 * click nobody answers navigates the tab off the offline copy, onto a route
 * that names no document, and drops a key held only in memory. Following it
 * selects the target in place; an id the record does not hold opens nothing.
 */
function useReplicaLinkTables(
  state: LoadState,
  selected: WorkspaceDocumentEntry | undefined,
  setSelectedPath: (path: string) => void,
) {
  const linkable = useMemo(
    (): readonly LinkableDocument[] =>
      state.kind === 'ready'
        ? state.entries.map((entry) => ({
            documentId: entry.documentId,
            path: entry.path,
            ...(entry.name === undefined ? {} : { name: entry.name }),
            ...(entry.kind === undefined ? {} : { kind: entry.kind }),
          }))
        : [],
    [state],
  )
  const resolveAlias = useMemo(() => createUniqueNameResolver(linkEntries(linkable)), [linkable])
  const resolveTitle = useMemo(() => linkTitles(linkable), [linkable])
  const excludeDocumentId = selected?.documentId
  const markdownLinks = useMemo(
    () => ({
      linkTargets: linkTargets(linkable, { excludeDocumentId }),
      // A wiki link names its target by id; a canvas file node by path on a
      // daemon record and by id elsewhere, so the one opener tries both.
      onOpenDocument: (reference: string) => {
        const target =
          linkable.find((entry) => entry.documentId === reference) ??
          linkable.find((entry) => entry.path === reference)
        if (target !== undefined) setSelectedPath(target.path)
      },
    }),
    [linkable, excludeDocumentId, setSelectedPath],
  )
  return { resolveAlias, resolveTitle, markdownLinks }
}

/**
 * The workspace's tag and stencil libraries and its tags in use, read out of
 * the replica record — the keeper that would answer them is the one that is
 * away.
 */
function useReplicaLibraries(state: LoadState) {
  // Read once per record, as the keeper pages read theirs once per source: a
  // library changes when someone edits the `tags` or `stencils` document,
  // which is rare, and the in-use list may run one tag behind a session.
  const tagLibrary = useMemo(
    () => (state.kind === 'ready' ? replicaTagLibrary(state.record, state.entries) : undefined),
    [state],
  )
  const tagsInUse = useMemo(
    () => (state.kind === 'ready' ? replicaTagsInUse(state.record, state.entries) : undefined),
    [state],
  )
  // The keeper pages' registry, from the same record: an inspector that does
  // not know a workspace stencil cannot take its appearance back off a node.
  const facetRegistry = useMemo(
    () =>
      state.kind === 'ready'
        ? withWorkspaceStencils(
            bundledFacetRegistry,
            replicaStencilLibrary(state.record, state.entries),
          )
        : bundledFacetRegistry,
    [state],
  )
  return { tagLibrary, tagsInUse, facetRegistry }
}

/**
 * The link table, reference seams, tag and stencil libraries and picture
 * seams the editors use on this replica.
 */
function useReplicaSeams(
  daemonBaseUrl: string,
  workspaceId: string,
  state: LoadState,
  selected: WorkspaceDocumentEntry | undefined,
  setSelectedPath: (path: string) => void,
) {
  const { resolveAlias, resolveTitle, markdownLinks } = useReplicaLinkTables(
    state,
    selected,
    setSelectedPath,
  )
  const graph = useMemo(
    () =>
      state.kind !== 'ready' || selected === undefined
        ? undefined
        : replicaReferenceGraph({
            record: state.record,
            entries: state.entries,
            selected,
            resolveAlias,
          }),
    [state, selected, resolveAlias],
  )
  const images = useReplicaImageUrls(workspaceId, graph?.images)
  const references = useMemo(
    () =>
      graph === undefined
        ? undefined
        : replicaReferenceWire({ references: graph, resolveAlias, resolveTitle, images }),
    [graph, resolveAlias, resolveTitle, images],
  )

  const seams = useMemo(
    () => (references === undefined ? undefined : referenceSeamsFromWire(references)),
    [references],
  )
  const { tagLibrary, tagsInUse, facetRegistry } = useReplicaLibraries(state)
  const clipboardImages = useMemo(
    () => replicaClipboardImages(daemonBaseUrl, workspaceId),
    [daemonBaseUrl, workspaceId],
  )
  return { seams, references, markdownLinks, tagLibrary, tagsInUse, facetRegistry, clipboardImages }
}

interface ReplicaReaderProps {
  entries: WorkspaceDocumentEntry[]
  label: string
  syncedAt: ReplicaReadPageProps['syncedAt']
  selected: WorkspaceDocumentEntry | undefined
  selectedPath: string | null
  setSelectedPath: (path: string) => void
  content: ReplicaContent | null
  draft: string | null
  spatialDraft: SpatialCanvas | null
  onDraftChange: (next: string) => void
  onSpatialChange: (next: SpatialCanvas) => void
  spatialLocks: ReturnType<typeof useReplicaEditing>['spatialLocks']
  seams: ReturnType<typeof referenceSeamsFromWire> | undefined
  references: ReferenceWire | undefined
  markdownLinks: ReturnType<typeof useReplicaLinkTables>['markdownLinks']
  tagLibrary: TagLibrary | undefined
  tagsInUse: readonly string[] | undefined
  facetRegistry: FacetRegistry
  clipboardImages: ClipboardImageSeams
  saveFailed: boolean
  onRetrySave: () => void
}

/**
 * Whether the replica's last save landed, said to both audiences: the page,
 * through the notice below, and the shell, through its one store — the way
 * the document pages publish theirs. The tab-wide readers (the leave prompt,
 * the unasked reload a waiting update would take, the shell mark) read only
 * that store, so a failure kept to this page would let a reload drop the
 * only copy of the edits.
 *
 * Mounted with the readable page alone: that is where edits are made, and
 * the only state the "Offline copy" word is true of.
 */
function PublishReplicaSaveHealth({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  useEffect(() => {
    setShellConnection({ state: { keeper: 'replica', storage: failed ? 'failed' : 'ok' } })
    return () => setShellConnection(null)
  }, [failed])
  return failed ? <ReplicaSaveFailedNotice onRetry={onRetry} /> : null
}

/**
 * A persistent notice, not a toast: the condition is "these edits exist only
 * in this tab", and it holds until a save lands. `role="alert"` because it
 * arrives carrying its message, which is the widely-supported shape for a
 * failure someone must hear about (polite-live-region.test.ts).
 */
function ReplicaSaveFailedNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      data-testid="replica-save-failed"
      className="flex items-center gap-3 border-b bg-destructive/10 px-4 py-2 text-sm"
    >
      <p className="min-w-0 flex-1">
        <span className="font-medium">{REPLICA_SAVE_FAILED_COPY.title}.</span>{' '}
        {REPLICA_SAVE_FAILED_COPY.body}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        {REPLICA_SAVE_FAILED_COPY.action}
      </Button>
    </div>
  )
}

/** Where the person is: the daemon is away and this is the copy cached here. */
function ReplicaOfflineBanner({
  name,
  syncedAt,
}: {
  name: string
  syncedAt: ReplicaReadPageProps['syncedAt']
}) {
  return (
    <div
      data-testid="replica-offline-banner"
      className="border-b bg-amber-500/10 px-4 py-2 text-sm"
    >
      <span className="font-medium">{name}</span>
      {' — the daemon that keeps this workspace is unreachable. '}
      This is the copy cached in this browser
      {syncedAt !== undefined && <> (synced {formatRelative(syncedAt, { pastDay: 'absolute' })})</>}
      . Edits save here and ship to the daemon when it returns.
    </div>
  )
}

/**
 * The spatial editor measures itself: inside a padded overflow-auto box its
 * h-full slightly overflows, a scrollbar appears, the box shrinks, the
 * scrollbar leaves — a ResizeObserver oscillation React reports as "maximum
 * update depth exceeded". Text content keeps the scrolling pane.
 */
function contentPaneClass(content: ReplicaContent | null): string {
  return content?.kind === 'spatial'
    ? 'min-w-0 flex-1 overflow-hidden'
    : 'min-w-0 flex-1 overflow-auto p-4'
}

/** The replica as a document surface: the banner, the tree, and the editor. */
function ReplicaReader({
  entries,
  label,
  syncedAt,
  selected,
  selectedPath,
  setSelectedPath,
  content,
  draft,
  spatialDraft,
  onDraftChange,
  onSpatialChange,
  spatialLocks,
  seams,
  references,
  markdownLinks,
  tagLibrary,
  tagsInUse,
  facetRegistry,
  clipboardImages,
  saveFailed,
  onRetrySave,
}: ReplicaReaderProps) {
  const { resolvedTheme } = useThemeMode()
  return (
    <div className="flex h-full flex-col" data-testid="replica-state-readable">
      <ReplicaOfflineBanner name={label} syncedAt={syncedAt} />
      <PublishReplicaSaveHealth failed={saveFailed} onRetry={onRetrySave} />
      <div className="flex min-h-0 flex-1">
        <div className="w-64 shrink-0 overflow-y-auto border-r p-2">
          <WorkspaceFileTree
            documents={entries}
            onOpen={(entry) => setSelectedPath(entry.path)}
            {...(selectedPath === null ? {} : { selectedPath })}
          />
        </div>
        <div className={contentPaneClass(content)}>
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
              {...markdownLinks}
              tagLibrary={tagLibrary}
              theme={resolvedTheme}
            />
          )}
          {content?.kind === 'spatial' && spatialDraft !== null && (
            <SpatialEditor
              key={selected?.documentId}
              canvas={spatialDraft}
              onChange={onSpatialChange}
              // Editing-forward: an offline visit that came here to fix
              // something should not need a switch off the hand tool first.
              defaultTool="select"
              className="h-full"
              references={references}
              onOpenFileRef={markdownLinks.onOpenDocument}
              tagLibrary={tagLibrary}
              tagSuggestions={tagsInUse}
              facetRegistry={facetRegistry}
              clipboardImages={clipboardImages}
              theme={resolvedTheme}
              {...spatialLocks}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/** The page once this browser's copy is gone: no editor, since nothing typed could be kept. */
function ReplicaCopyRemovedNotice() {
  return (
    <p className="p-4 text-sm text-muted-foreground" data-testid="replica-state-copy-removed">
      {REPLICA_COPY_REMOVED_COPY}
    </p>
  )
}

/**
 * What the live region says. Mounted before it speaks
 * (polite-live-region.test.ts): a role="status" region that arrives already
 * carrying its message is announced inconsistently, so that ONE region stays
 * in the DOM for the page's whole life and only its text changes — sr-only
 * when there is nothing to say, since the visible copy says the same thing
 * for a sighted reader.
 *
 * 'locked', 'needs-connection' and 'rotated' all render NOTHING but one
 * message, so a screen-reader user landing there (first mount, or after a
 * Reconnect attempt that settles back) must hear it — not just 'Loading…'
 * followed by silence.
 */
function replicaLiveStatus({
  state,
  reconnecting,
  pageState,
  lockedLine,
  copyRemoved,
}: {
  state: LoadState
  reconnecting: boolean
  pageState: ReturnType<typeof replicaPageState> | null
  lockedLine: string | undefined
  copyRemoved: boolean
}): string | null {
  if (copyRemoved) return REPLICA_COPY_REMOVED_COPY
  if (state.kind === 'loading') return 'Loading…'
  if (reconnecting) return 'Reconnecting…'
  if (pageState === 'removed') return REPLICA_STATE_COPY.removed.body
  if (pageState === 'locked' || pageState === 'needs-connection' || pageState === 'rotated') {
    return REPLICA_STATE_COPY[pageState].body + (lockedLine ? ` ${lockedLine}` : '')
  }
  if (pageState === 'unlockable') return REPLICA_STATE_COPY.unlockable.body
  return null
}

export function ReplicaReadPage({
  workspaceId,
  segment,
  displayName,
  syncedAt,
  daemonBaseUrl,
  withheld,
  onReconnect,
}: ReplicaReadPageProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  // Bumped by Reconnect to re-run the load effect below without touching
  // `workspaceId` — a forget()+re-ask must go through the SAME open() path
  // a cold load takes, never a bespoke retry.
  const [attempt, setAttempt] = useState(0)
  const [reconnecting, setReconnecting] = useState(false)
  const [unlocking, setUnlocking] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const { scheduleSave, retrySave, saveFailed, copyRemoved } = useReplicaSaveQueue(workspaceId)

  useReplicaRecord({ workspaceId, daemonBaseUrl, attempt, withheld, setState })

  // Read on every render rather than held in state: `unlockReplicaKey` can
  // DROP the blob (a spent lease, ciphertext nothing here opens), and a
  // remembered flag captured once would go on offering an unlock that has
  // just been established to be impossible. The `attempt` bump an unlock ends
  // with is what re-reads it.
  const remembered = isReplicaReadableOffline(daemonBaseUrl, workspaceId)
  const pageState =
    state.kind === 'loading' || copyRemoved
      ? null
      : replicaPageState({ key: keyInputFor(state), remembered })

  /**
   * The cold start (ADR-0042 decision 6). No `forget` first, unlike
   * Reconnect: there is nothing stale to clear, and forgetting would drop
   * the very cache `unlockReplicaKey` is about to fill. Re-asking the page
   * afterwards is what turns a taken key into content — and what re-reads
   * `remembered` when the attempt dropped the blob instead.
   */
  const handleUnlock = useCallback(async () => {
    if (unlocking) return
    setUnlocking(true)
    try {
      await unlockReplicaKey({ daemonBaseUrl, workspaceId })
    } finally {
      setUnlocking(false)
      setAttempt((a) => a + 1)
    }
  }, [daemonBaseUrl, workspaceId, unlocking])

  // forget-then-ask (ADR-0042's own reconnect contract): the failure mode is a stale cached `withheld:'unreachable'` outliving a
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

  // What the selected document points at is answered from the replica record
  // itself (`replicaReferenceWire`), so references work on the one page that
  // exists BECAUSE the daemon is unreachable. The same two tables both keeper pages build, over this record's own
  // entries — so a `[[...]]` written here resolves by the rules the rest of
  // the app already applies (path or id; a display name is a label, never a
  // target) rather than by a lookup this page invented for itself.
  const drawnWith = useReplicaSeams(daemonBaseUrl, workspaceId, state, selected, setSelectedPath)
  const editing = useReplicaEditing({
    record: state.kind === 'ready' ? state.record : undefined,
    selected,
    scheduleSave,
  })

  const lockedLine = state.kind === 'withheld' ? lockedDetail(state.reason) : undefined
  const liveStatus = replicaLiveStatus({ state, reconnecting, pageState, lockedLine, copyRemoved })

  return (
    <div className="flex h-full flex-col" data-testid="replica-read-page">
      <p role="status" aria-live="polite" data-testid="replica-live-status" className="sr-only">
        {liveStatus ?? ''}
      </p>
      {state.kind === 'loading' && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
      {copyRemoved && <ReplicaCopyRemovedNotice />}
      {pageState === 'readable' && state.kind === 'ready' && (
        <ReplicaReader
          entries={state.entries}
          label={workspaceLabel({ workspaceId, segment, displayName })}
          syncedAt={syncedAt}
          selected={selected}
          selectedPath={selectedPath}
          setSelectedPath={setSelectedPath}
          {...editing}
          {...drawnWith}
          saveFailed={saveFailed}
          onRetrySave={retrySave}
        />
      )}
      {(pageState === 'needs-connection' || pageState === 'locked' || pageState === 'rotated') && (
        <ReplicaActionPanel
          state={pageState}
          body={REPLICA_STATE_COPY[pageState].body + (lockedLine ? ` ${lockedLine}` : '')}
          action={REPLICA_STATE_COPY[pageState].action}
          busy={reconnecting}
          busyLine="Reconnecting…"
          onAction={() => void handleReconnect()}
        />
      )}
      {pageState === 'unlockable' && (
        <ReplicaActionPanel
          state="unlockable"
          body={REPLICA_STATE_COPY.unlockable.body}
          action={REPLICA_STATE_COPY.unlockable.action}
          busy={unlocking}
          busyLine="Waiting for your passkey…"
          onAction={() => void handleUnlock()}
        />
      )}
      {pageState === 'removed' && (
        <p className="p-4 text-sm text-muted-foreground" data-testid="replica-state-removed">
          {REPLICA_STATE_COPY.removed.body}
        </p>
      )}
    </div>
  )
}
