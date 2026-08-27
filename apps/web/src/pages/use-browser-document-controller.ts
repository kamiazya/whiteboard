import { projectWorkspaceDocument } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { useCallback, useEffect, useRef, useState } from 'react'
import { mergeToSnapshot } from '../components/migration/import-from-browser.js'
import { newDocumentPathIn } from '../components/workspace-files/new-document-path.js'
import { BrowserWorkspaceDocs } from '../lib/browser-workspace-docs.js'
import { deriveCopyName } from '../lib/derive-copy-name.js'
import {
  BROWSER_WORKSPACE_ID,
  type ContentClock,
  type DefaultDocumentPointer,
  ensureLocalWorkspace,
  IdbDefaultDocumentPointer,
  idbContentClock,
  listLocalDocuments,
  loadLocalDocument,
} from '../lib/local-document-summary.js'
import { LoroStore, type LoroStoreLike } from '../lib/loro-store.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'
import { seedWorkspaceDocumentContent, touchIfWorkspaceBacked } from '../lib/workspace-content.js'

// Re-exported so the many page-side consumers keep their import path; the
// type itself lives beside the concrete store.
export type { LoroStoreLike }

export type BrowserPersistenceState =
  | { kind: 'saved'; lastSavedAt: null | string }
  | { kind: 'pending'; lastSavedAt: null | string }
  | { kind: 'saving'; lastSavedAt: null | string }
  | { kind: 'degraded'; reason: string; message: string; lastSavedAt: null | string }

export interface BrowserDocumentController {
  /**
   * The resolved Loro store this controller persists through. Exposed so
   * sibling consumers (the markdown-body hook) share the SAME instance —
   * resolving the optional page prop's default twice would silently split
   * spatial and markdown persistence across two stores.
   */
  loro: LoroStoreLike
  snapshot: DocumentSnapshot | null
  persistence: BrowserPersistenceState
  cleanupCompleted: boolean
  cleanupError: string | null
  // Resolves once the rename is flushed, rejects if the underlying save
  // failed — callers (e.g. WorkspaceTopBar) rely on the rejection to keep a
  // rename input open for retry instead of silently closing it.
  renameDocument(name: string): Promise<void>
  triggerCleanup(): Promise<void>
  startFresh(): Promise<void>
  listDocuments(): Promise<DocumentSnapshot[]>
  createDocument(name?: string, kind?: DocumentSnapshot['kind']): Promise<DocumentSnapshot>
  /** Resolves true when the switch landed; false when superseded, when the
   *  target is missing (recoverable — e.g. a stale deep link), or when the
   *  store degraded. */
  switchDocument(id: string): Promise<boolean>
  // Duplicates the CURRENTLY open canvas (flushing any pending edit first so
  // the copy reflects the latest state) under a derived "<name> (copy)" name,
  // then switches to it — matching the create-then-open flow the UI expects.
  duplicateDocument(): Promise<DocumentSnapshot>
}

/**
 * Create a document AND seed its content record, as one operation.
 *
 * The seed is not optional bookkeeping. `updatedAt` now comes from the content
 * record's own envelope — the metadata row has no timestamp of its own, and
 * the port's `DocumentEntry` carries none — so a document created without one
 * has no last-edited time to report. It is also what lets a switch onto a
 * never-edited document find something to load.
 *
 * Three of the five create paths used to skip it (first boot, startFresh, and
 * the list page) while `createDocument` did it and said why. Routing them all
 * through here is what makes that inconsistency unrepresentable rather than
 * merely fixed.
 *
 * The index row is rolled back if the content write fails, so a failed create
 * never leaves a document with nothing behind it.
 */
export async function createSeededDocument(
  index: DocumentIndex,
  loro: LoroStoreLike,
  clock: ContentClock,
  name?: string,
  kind: DocumentSnapshot['kind'] = 'spatial',
  content?: Uint8Array,
): Promise<DocumentSnapshot> {
  await ensureLocalWorkspace(index)
  const taken = (await listLocalDocuments(index, clock).catch(() => [])).map((row) => row.path)
  const trimmed = name?.trim()
  const entry = await index.createDocument({
    workspaceId: BROWSER_WORKSPACE_ID,
    path: newDocumentPathIn('', taken),
    kind,
    ...(trimmed ? { name: trimmed } : {}),
  })
  try {
    // Tree-backed index: the node the create just made IS the content record
    // (its containers are the empty document), so a seed with content copies
    // into it and an empty create only stamps the clock. The legacy branch
    // keeps the per-document record for an index without a workspace
    // document behind it — injected test doubles included.
    const seededInTree =
      content !== undefined
        ? await seedWorkspaceDocumentContent(entry.documentId, content)
        : await touchIfWorkspaceBacked(entry.documentId)
    if (!seededInTree) {
      await loro.save(entry.documentId, content ?? loro.createEmptySnapshot())
    }
  } catch (err) {
    try {
      await index.deleteDocument({ workspaceId: BROWSER_WORKSPACE_ID, path: entry.path })
    } catch {
      // Rollback is best-effort; a stray index row is harmless next to
      // reporting a create that did not happen.
    }
    throw err
  }
  const snap = await loadLocalDocument(index, entry.documentId, clock)
  if (snap === null) throw new Error('created document vanished before it could be read')
  return snap
}

/**
 * What the browser editor is wired to.
 *
 * Named rather than positional because the bespoke store's single object
 * became four collaborators, and three of them are optional — a positional
 * list that long makes the common call site a row of `undefined`, and puts
 * the two IndexedDB-backed ones in an order nobody can read back.
 */
export interface BrowserControllerDeps {
  loro?: LoroStoreLike
  /**
   * A document PATH requested by the URL (e.g. a bookmarked /local/:path deep
   * link), read once at mount. The URL addresses a document the way the daemon
   * does — by workspace-relative path, not by id — so this resolves through
   * the list before loading. Takes priority over the default-document pointer,
   * which it also repoints on success so a later plain (no deep link) load
   * resumes here — the same contract switchDocument already has. A
   * stale/moved path falls back to the normal flow rather than showing an
   * error: a dead bookmark must not dead-end the user.
   */
  initialPath?: string
  /**
   * The two things `DocumentIndex` does not own. Defaulted so production wires
   * nothing extra, and injectable because both read IndexedDB, which the jsdom
   * test project does not have.
   */
  pointer?: DefaultDocumentPointer
  clock?: ContentClock
}

// Module-level rather than per-call defaults: these are stateless handles on
// the same IndexedDB, and one identity apiece keeps a re-render from minting a
// new collaborator the effect deps would have to ignore.
const defaultLoroStore = /* @__PURE__ */ new LoroStore()
const defaultPointer: DefaultDocumentPointer = /* @__PURE__ */ new IdbDefaultDocumentPointer()
const defaultClock: ContentClock = /* @__PURE__ */ idbContentClock()

export function useBrowserDocumentController(
  index: DocumentIndex,
  deps: BrowserControllerDeps = {},
): BrowserDocumentController {
  const {
    loro = defaultLoroStore,
    initialPath,
    pointer = defaultPointer,
    clock = defaultClock,
  } = deps
  const [snapshot, setSnapshot] = useState<DocumentSnapshot | null>(null)
  const [persistence, setPersistence] = useState<BrowserPersistenceState>({
    kind: 'saved',
    lastSavedAt: null,
  })
  const [cleanupCompleted, setCleanupCompleted] = useState(false)
  const [cleanupError, setCleanupError] = useState<string | null>(null)

  // Stable refs so timer callbacks always see current state without re-creating
  const indexRef = useRef(index)
  indexRef.current = index
  const pointerRef = useRef(pointer)
  pointerRef.current = pointer
  const clockRef = useRef(clock)
  clockRef.current = clock
  const loroRef = useRef(loro)
  loroRef.current = loro
  const setPersistenceRef = useRef(setPersistence)
  setPersistenceRef.current = setPersistence
  const persistenceRef = useRef(persistence)
  persistenceRef.current = persistence
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const pendingSnapshotRef = useRef<DocumentSnapshot | null>(null)
  // Guards overlapping switchDocument calls (a fast switcher double-click, or a
  // burst of browser Back/Forward): only the call that is still the latest
  // requested one when its async load settles is allowed to commit state, so
  // an earlier call resolving after a later one can never clobber it.
  const switchGenerationRef = useRef(0)
  // Tracks the currently in-flight flush so overlapping callers (renameDocument's
  // fire-and-forget flush racing with switchDocument's own awaited flush) serialize
  // on the real outcome instead of the second caller observing an already-cleared
  // pendingSnapshotRef and returning true before the first save actually settles.
  const savePromiseRef = useRef<Promise<boolean> | null>(null)

  // Returns true if there was nothing to flush or the flush succeeded.
  // Returns false if a pending save failed — callers that depend on data
  // integrity (e.g. triggerCleanup, switchDocument) must abort when this returns false.
  //
  // Loops instead of awaiting the in-flight save once: two concurrent callers
  // both awaiting the same prior save wake up in the same microtask batch, and
  // the first to resume can consume pendingSnapshotRef and start the next save
  // before the second checks it. Looping back after every await re-reads
  // savePromiseRef/pendingSnapshotRef so the second caller picks up and awaits
  // that newly-started save instead of returning true while it is still
  // in flight.
  const flushSave = useCallback(async (): Promise<boolean> => {
    for (;;) {
      if (savePromiseRef.current !== null) {
        const priorOk = await savePromiseRef.current
        if (!priorOk) return false
        continue
      }
      const snap = pendingSnapshotRef.current
      if (snap === null) return true
      pendingSnapshotRef.current = null
      setPersistenceRef.current((p) => ({ kind: 'saving', lastSavedAt: p.lastSavedAt ?? null }))
      const promise = (async (): Promise<boolean> => {
        try {
          // A rename is the only mutation that reaches the save path, and the
          // index keys it by id so the document does not move.
          await indexRef.current.setDocumentName({
            workspaceId: BROWSER_WORKSPACE_ID,
            documentId: snap.documentId,
            // Omitted when it equals the path, which is how the index spells
            // "no name of its own" — see `toSnapshot`'s fallback.
            ...(snap.name === snap.path ? {} : { name: snap.name }),
          })
          setPersistenceRef.current({ kind: 'saved', lastSavedAt: new Date().toISOString() })
          return true
        } catch {
          // Generic safe copy — do not expose raw IndexedDB error
          setPersistenceRef.current((p) => ({
            kind: 'degraded',
            reason: 'save-failed',
            message: 'Changes could not be saved.',
            lastSavedAt: p.lastSavedAt ?? null,
          }))
          return false
        } finally {
          savePromiseRef.current = null
        }
      })()
      savePromiseRef.current = promise
      const ok = await promise
      if (!ok) return false
      // Loop again: another edit may have queued a new pending snapshot
      // while this save was in flight.
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (initialPath !== undefined) {
        // An index that cannot resolve is indistinguishable from a path that
        // is not there, and both fall through to the same place. Letting the
        // read throw instead would dead-end EVERY deep link on a degraded
        // store — and App mounts this page only with a path, so that is every
        // mount.
        const requested = await indexRef.current
          .resolveDocument({ workspaceId: BROWSER_WORKSPACE_ID, path: initialPath })
          .catch(() => null)
        if (cancelled) return
        if (requested !== null) {
          const snap = await loadLocalDocument(
            indexRef.current,
            requested.documentId,
            clockRef.current,
          )
          if (cancelled) return
          if (snap !== null) {
            await pointerRef.current.set(requested.documentId)
            if (!cancelled) setSnapshot(snap)
            return
          }
        }
        // Not found: silently fall through to the normal default-document flow
        // below rather than showing a degraded banner — a stale bookmark must
        // not dead-end the user.
      }

      const id = await pointerRef.current.get()
      if (cancelled) return

      if (id === null) {
        const created = await createSeededDocument(
          indexRef.current,
          loroRef.current,
          clockRef.current,
        )
        if (cancelled) return
        await pointerRef.current.set(created.documentId)
        if (!cancelled) setSnapshot(created)
        return
      }

      const snap = await loadLocalDocument(indexRef.current, id, clockRef.current)
      if (cancelled) return
      if (snap !== null) {
        setSnapshot(snap)
      } else {
        // The pointer names a document the index no longer has. Generic safe
        // copy, no raw error.
        setPersistenceRef.current({
          kind: 'degraded',
          reason: 'load-failed',
          message: 'The canvas data could not be read.',
          lastSavedAt: null,
        })
      }
    }

    load().catch(() => {
      if (!cancelled) {
        setPersistenceRef.current({
          kind: 'degraded',
          reason: 'load-failed',
          message: 'The canvas could not be loaded.',
          lastSavedAt: null,
        })
      }
    })

    return () => {
      cancelled = true
    }
  }, []) // store identity is stable; storeRef tracks current value

  // Discrete edit — flush immediately (no debounce) so a rename
  // never lingers as "Unsaved changes" and survives a fast reload.
  const renameDocument = useCallback(
    (name: string): Promise<void> => {
      // Merge with the freshest pending snapshot instead of committed state, so
      // a concurrent edit in flight is never clobbered. Computed
      // from refs (not a setState updater) so pendingSnapshotRef is guaranteed
      // current before the immediate flushSave below reads it.
      const base = pendingSnapshotRef.current ?? snapshotRef.current
      if (base === null) return Promise.resolve()
      // A cleared name becomes the PATH, not an 'untitled' sentinel: the
      // index stores an unnamed document by omitting `name`, and the listing
      // projects the path back. A literal sentinel was a third state that
      // agreed with neither, and it stopped matching the moment paths started
      // being numbered ('untitled-2' is an ordinary path, not a sentinel).
      const normalized = name.trim() || base.path
      const updated: DocumentSnapshot = {
        ...base,
        name: normalized,
        updatedAt: new Date().toISOString(),
      }
      pendingSnapshotRef.current = updated
      // Also advance snapshotRef synchronously: it is the fallback merge base
      // (read above when pendingSnapshotRef is null after a flush clears it), so
      // leaving it stale until the next render could let a follow-up edit merge
      // onto a pre-rename base.
      snapshotRef.current = updated
      setSnapshot(updated)
      setPersistenceRef.current((p) => ({ kind: 'pending', lastSavedAt: p.lastSavedAt ?? null }))
      return flushSave().then((ok) => {
        if (!ok) throw new Error('Failed to save the renamed canvas.')
      })
    },
    [flushSave],
  )

  const triggerCleanup = useCallback(async () => {
    setCleanupError(null)
    // Abort if flush fails — unsaved edits must not be silently discarded.
    const flushed = await flushSave()
    if (!flushed) {
      setCleanupError('Your changes could not be saved. The canvas copy has been kept.')
      return
    }
    // Abort if a previous save already failed; data integrity is uncertain.
    if (persistenceRef.current.kind === 'degraded') {
      setCleanupError('The canvas could not be safely removed. Your copy has been kept.')
      return
    }
    const id = await pointerRef.current.get()
    if (id === null) return
    try {
      const entry = await indexRef.current.resolveDocumentById({
        workspaceId: BROWSER_WORKSPACE_ID,
        documentId: id,
      })
      if (entry === null) return // the pointer names nothing: silent no-op
      await indexRef.current.deleteDocument({
        workspaceId: BROWSER_WORKSPACE_ID,
        path: entry.path,
      })
      await pointerRef.current.clear()
      setSnapshot(null)
      setCleanupCompleted(true)
    } catch {
      // Generic safe copy — do not expose raw IDB error
      setCleanupError('The canvas could not be removed. Your copy has been kept.')
    }
  }, [flushSave])

  const startFresh = useCallback(async () => {
    setCleanupError(null)
    let fresh: DocumentSnapshot
    try {
      // Create BEFORE repointing, so a failed create never leaves the pointer
      // aimed at a document that does not exist (which would reload degraded).
      fresh = await createSeededDocument(indexRef.current, loroRef.current, clockRef.current)
      const existingId = await pointerRef.current.get()
      // Order no longer matters here. The old `del` removed only the document
      // the pointer aimed at and cleared it as it went, so the drop had to
      // precede the repoint or it silently no-op'd; deleting by path has no
      // such coupling.
      if (existingId !== null && existingId !== fresh.documentId) {
        try {
          const stale = await indexRef.current.resolveDocumentById({
            workspaceId: BROWSER_WORKSPACE_ID,
            documentId: existingId,
          })
          if (stale !== null) {
            // Cleared BEFORE the row goes, and not left for the repoint
            // below to overwrite: if that repoint then fails, a pointer still
            // naming the deleted document would make the next plain load
            // degrade instead of starting clean. The bespoke store got this
            // for free — its `del` cleared the pointer as it deleted — and
            // deleting by path has no such coupling, so the clear is explicit.
            await pointerRef.current.clear()
            await indexRef.current.deleteDocument({
              workspaceId: BROWSER_WORKSPACE_ID,
              path: stale.path,
            })
          }
        } catch {
          // Dropping the old document is best-effort; failure must not abort recovery.
        }
      }
      await pointerRef.current.set(fresh.documentId)
    } catch {
      // Recovery itself failed. If the failure landed on the final setDefaultDocumentId, the
      // freshly-saved canvas is written but never pointed to — del() can't reach it (it only
      // removes the current default), so drop the orphan via the pointer-independent
      // removeDocument. Best-effort: cleanup failure must not mask the degraded view, which
      // keeps the user on a retry-able state instead of showing "Saved" over a dangling pointer.
      // No orphan cleanup here any more: `createSeededDocument` rolls its own
      // index row back when the content write fails, and a failure after that
      // point leaves a document that is complete and simply not pointed at —
      // which the next create numbers around rather than trips over.
      setPersistenceRef.current({
        kind: 'degraded',
        reason: 'recovery-failed',
        message: 'Could not start a new canvas. Please try again.',
        lastSavedAt: null,
      })
      return
    }
    setSnapshot(fresh)
    setPersistenceRef.current({ kind: 'saved', lastSavedAt: new Date().toISOString() })
    setCleanupCompleted(false)
  }, [])

  const listDocuments = useCallback((): Promise<DocumentSnapshot[]> => {
    return listLocalDocuments(indexRef.current, clockRef.current)
  }, [])

  const createDocument = useCallback(
    async (
      name?: string,
      kind: DocumentSnapshot['kind'] = 'spatial',
    ): Promise<DocumentSnapshot> => {
      return createSeededDocument(indexRef.current, loroRef.current, clockRef.current, name, kind)
    },
    [],
  )

  const switchDocument = useCallback(
    async (id: string): Promise<boolean> => {
      const generation = ++switchGenerationRef.current
      // Flush any pending edit on the current canvas before switching away
      // from it, so a fast switch never drops an in-flight rename.
      const flushed = await flushSave()
      if (generation !== switchGenerationRef.current) return false // superseded while flushing
      if (!flushed) return false
      try {
        const loaded = await loadLocalDocument(indexRef.current, id, clockRef.current)
        if (generation !== switchGenerationRef.current) return false // superseded while loading
        if (loaded === null) {
          // A missing target is a RECOVERABLE miss, not a degraded store: it
          // is exactly what a stale /local/:path bookmark produces, and parking
          // the page on a degraded screen would dead-end the user. Leave the
          // current document untouched and let the caller decide (the page
          // replaces the URL with the still-loaded document).
          //
          // There is no longer a third outcome here. `load` used to answer
          // 'corrupted' for a metadata row that would not parse; the index
          // either holds the document or it does not, and whether its CONTENT
          // reads is `LoroStore.load`'s answer to give, on the path that
          // actually reads bytes. The degraded branch that used to sit here
          // said "could not be switched" about a document that had switched.
          return false
        }
        await pointerRef.current.set(id)
        if (generation !== switchGenerationRef.current) return false // superseded while persisting the pointer
        snapshotRef.current = loaded
        setSnapshot(loaded)
        // Clear any stale degraded banner left over from the previous canvas —
        // a successful switch to a freshly-loaded, in-sync canvas should not keep
        // showing an error from before the switch.
        setPersistenceRef.current({ kind: 'saved', lastSavedAt: new Date().toISOString() })
        return true
      } catch {
        if (generation !== switchGenerationRef.current) return false
        // Generic safe copy — do not expose raw IndexedDB error. Current
        // snapshot and default pointer are left untouched: a failed switch
        // must not corrupt the still-current canvas view.
        setPersistenceRef.current((p) => ({
          kind: 'degraded',
          reason: 'switch-failed',
          message: 'The canvas could not be switched.',
          lastSavedAt: p.lastSavedAt ?? null,
        }))
        return false
      }
    },
    [flushSave],
  )

  // Reads the source canvas's Loro record through mergeToSnapshot (the same
  // snapshot+delta-log -> single-snapshot collapse the browser ->
  // daemon copy-first import path already uses) so the duplicate is a true
  // deep copy: a fresh Uint8Array with no shared reference to the source's
  // bytes, deltas, or underlying LoroDoc.
  const duplicateDocument = useCallback(async (): Promise<DocumentSnapshot> => {
    const flushed = await flushSave()
    if (!flushed) throw new Error('Failed to save pending changes before duplicating.')
    const source = snapshotRef.current
    if (source === null) throw new Error('No canvas is open to duplicate.')

    // The workspace document is where an edited document's current state
    // lives; the per-document record is the pre-fold copy and goes stale the
    // moment the editor commits. Projection first, old record as the fallback
    // for a document nothing has folded yet (and for jsdom tests, whose
    // injected store is the only storage there is).
    const workspace = await new BrowserWorkspaceDocs().open(BROWSER_WORKSPACE_ID).catch(() => null)
    const projected =
      workspace === null ? null : projectWorkspaceDocument(workspace, source.documentId)
    let mergedSnapshot: Uint8Array
    if (projected !== null) {
      mergedSnapshot = new Uint8Array(projected.export({ mode: 'snapshot' }))
    } else {
      const loroResult = await loroRef.current.load(source.documentId)
      if (loroResult.kind !== 'ok') {
        throw new Error('The canvas data could not be read for duplication.')
      }
      mergedSnapshot = mergeToSnapshot(loroResult.snapshot, loroResult.deltas ?? [])
    }

    const existingNames = new Set(
      (await listLocalDocuments(indexRef.current, clockRef.current)).map((row) => row.name),
    )
    const fresh = await createSeededDocument(
      indexRef.current,
      loroRef.current,
      clockRef.current,
      deriveCopyName(source.name, existingNames),
      source.kind,
      // The copy is seeded with the SOURCE's merged bytes rather than an empty
      // document — that is the whole point of a duplicate, and the seeding
      // helper takes content for exactly this caller.
      mergedSnapshot,
    )

    await switchDocument(fresh.documentId)
    return fresh
  }, [flushSave, switchDocument])

  return {
    loro: loroRef.current,
    snapshot,
    persistence,
    cleanupCompleted,
    cleanupError,
    renameDocument,
    triggerCleanup,
    startFresh,
    listDocuments,
    createDocument,
    switchDocument,
    duplicateDocument,
  }
}
