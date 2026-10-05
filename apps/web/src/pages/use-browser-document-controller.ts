import { documentNameSchema } from '@kamiazya/whiteboard-model'
import type { DocumentIndex } from '@kamiazya/whiteboard-ports'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getAppLogger } from '../lib/app-logger.js'
import {
  type ContentClock,
  type DefaultDocumentPointer,
  IdbDefaultDocumentPointer,
  idbContentClock,
  listBrowserDocuments,
  loadBrowserDocument,
} from '../lib/browser-document-summary.js'
import type { BrowserPersistenceState } from '../lib/browser-persistence-state.js'
import { browserWorkspaceIdOrNull, getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { createSeededDocument } from '../lib/create-seeded-document.js'
import { duplicateBrowserDocument } from '../lib/duplicate-browser-document.js'
import { kindNoun } from '../lib/kind-noun.js'
import { LoroStore, type LoroStoreLike } from '../lib/loro-store.js'
import { trackIndexWrite } from '../lib/pending-index-writes.js'
import type { DocumentSnapshot } from '../lib/whiteboard-client.js'

const log = getAppLogger('browser-document-controller')

// Re-exported so the many page-side consumers keep their import path; the
// type itself lives beside the concrete store.
export type { LoroStoreLike }

export interface BrowserDocumentController {
  /**
   * The resolved Loro store this controller persists through. Exposed so
   * the page's other readers (the files source, its connections) share the SAME
   * instance — resolving the optional page prop's default twice would
   * silently split persistence across two stores.
   */
  loro: LoroStoreLike
  snapshot: DocumentSnapshot | null
  persistence: BrowserPersistenceState
  // Resolves once the rename is flushed, rejects if the underlying save
  // failed — callers (e.g. WorkspaceTopBar) rely on the rejection to keep a
  // rename input open for retry instead of silently closing it.
  renameDocument(name: string): Promise<void>
  /**
   * Shows the name the workspace record now holds — `null` for none — when
   * something other than this controller wrote it: the keeper naming a note
   * after its heading, or another tab's rename. Never saved: the record
   * already holds it, and a save is a rename, which would mark it chosen. A
   * rename of this page's own that has not landed yet wins.
   */
  followRecordedName(name: string | null): void
  /**
   * Resolves once the document is gone and what is left is open (a fresh
   * document when nothing is), or when there is nothing to delete; REJECTS
   * with the sentence to show when it refused and kept the document — the
   * shape `use-document-actions.tsx` reads, the same as the daemon keeper's.
   */
  deleteDocument(): Promise<void>
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

/**
 * The stores a page reads to decide which document it opens. Taken as a
 * bundle because the two candidate sources below each want most of them, and
 * threading four refs through each is an argument list saying nothing.
 */
interface OpeningStores {
  readonly index: DocumentIndex
  readonly pointer: DefaultDocumentPointer
  readonly clock: ContentClock
  readonly loro: LoroStoreLike
}

/**
 * Whether this mount is still the one on screen.
 *
 * Passed rather than checked once at the end, because most of the
 * cancellation points below guard a WRITE — setting the pointer, seeding a
 * document — not merely a `setState` on a component that has gone. A
 * resolution that only checked when it finished would still perform them.
 */
type StillMounted = () => boolean

/**
 * The document a deep link names, or null when the path resolves to nothing.
 *
 * An index that cannot resolve is indistinguishable from a path that is not
 * there, and both answer null: letting the read throw would dead-end EVERY
 * deep link on a degraded store, and App mounts this page only with a path,
 * so that is every mount. The workspace id is read through the null-answering
 * accessor for the same reason — in an argument position its throw would
 * precede the promise and escape the caller's `catch`.
 */
async function openDeepLink(
  stores: OpeningStores,
  path: string,
  alive: StillMounted,
): Promise<DocumentSnapshot | null> {
  const workspaceId = browserWorkspaceIdOrNull()
  const requested =
    workspaceId === null
      ? null
      : await stores.index.resolveDocument({ workspaceId, path }).catch(() => null)
  if (!alive() || requested === null) return null
  const snap = await loadBrowserDocument(stores.index, requested.documentId, stores.clock)
  if (!alive() || snap === null) return null
  await stores.pointer.set(requested.documentId)
  return alive() ? snap : null
}

/**
 * The document the pointer names, seeding a new one when it names nothing.
 *
 * A pointer naming a document the index no longer has opens what is left,
 * as a delete does. It is not unreadable data — the pointer outlived its
 * document (a delete whose repoint had not landed, another tab's delete) —
 * and an error screen there is a dead end with nothing to recover.
 */
async function openPointedAt(
  stores: OpeningStores,
  alive: StillMounted,
): Promise<DocumentSnapshot | null> {
  const id = await stores.pointer.get()
  if (!alive()) return null
  if (id === null) {
    const created = await createSeededDocument(stores.index, stores.loro, stores.clock)
    if (!alive()) return null
    await stores.pointer.set(created.documentId)
    return alive() ? created : null
  }
  const snap = await loadBrowserDocument(stores.index, id, stores.clock)
  if (!alive()) return null
  if (snap !== null) return snap
  const left = await openWhatIsLeft(stores, alive)
  return alive() ? left : null
}

/**
 * What a delete leaves open: the first document still listed, as the daemon
 * keeper does, or a fresh one when none is — this keeper's first-visit answer
 * to an empty workspace, where the daemon has an empty state instead.
 *
 * `alive` stops an OPEN that the page abandoned from seeding or repointing;
 * a delete passes none, since its repoint must land whether or not the page
 * is still there to show the result.
 */
function openWhatIsLeft(stores: OpeningStores): Promise<DocumentSnapshot>
function openWhatIsLeft(
  stores: OpeningStores,
  alive: StillMounted,
): Promise<DocumentSnapshot | null>
async function openWhatIsLeft(
  stores: OpeningStores,
  alive: StillMounted = () => true,
): Promise<DocumentSnapshot | null> {
  const [next] = await listBrowserDocuments(stores.index, stores.clock)
  if (!alive()) return null
  const opened = next ?? (await createSeededDocument(stores.index, stores.loro, stores.clock))
  if (!alive()) return null
  await stores.pointer.set(opened.documentId)
  return opened
}

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
  // integrity (e.g. deleteDocument, switchDocument) must abort when this returns false.
  //
  // Loops instead of awaiting the in-flight save once: two concurrent callers
  // both awaiting the same prior save wake up in the same microtask batch, and
  // the first to resume can consume pendingSnapshotRef and start the next save
  // before the second checks it. Looping back after every await re-reads
  // savePromiseRef/pendingSnapshotRef so the second caller picks up and awaits
  // that newly-started save instead of returning true while it is still
  // in flight.
  const runFlush = useCallback(async (): Promise<boolean> => {
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
            workspaceId: getBrowserWorkspaceId(),
            documentId: snap.documentId,
            // Omitted when it equals the path, which is how the index spells
            // "no name of its own" — see `toSnapshot`'s fallback.
            ...(snap.name === snap.path ? {} : { name: snap.name }),
          })
          setPersistenceRef.current({ kind: 'saved', lastSavedAt: new Date().toISOString() })
          return true
        } catch (err) {
          log.warn('a rename could not be saved; the person sees the generic copy', err)
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

  // Registered for as long as the whole loop runs, not just the one write
  // inside it: a keystroke whose snapshot the loop has not reached yet holds
  // no transaction, and that is exactly the window a read must not slip
  // through. See lib/pending-index-writes.ts.
  const flushSave = useCallback((): Promise<boolean> => trackIndexWrite(runFlush()), [runFlush])

  useEffect(() => {
    let cancelled = false
    const alive = () => !cancelled

    async function load() {
      const stores: OpeningStores = {
        index: indexRef.current,
        pointer: pointerRef.current,
        clock: clockRef.current,
        loro: loroRef.current,
      }
      // A deep link that resolves to nothing falls through to the normal
      // default-document flow rather than showing a degraded banner — a stale
      // bookmark must not dead-end the user.
      const deepLinked =
        initialPath === undefined ? null : await openDeepLink(stores, initialPath, alive)
      if (!alive()) return
      const opened = deepLinked ?? (await openPointedAt(stores, alive))
      if (!alive() || opened === null) return
      setSnapshot(opened)
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
      // Judged before the snapshot shows it: the index refuses the same bound
      // only after, as a failed save that degrades persistence and so blocks
      // Delete. The path is exempt — it is stored as no name at all.
      const bounded = normalized === base.path ? null : documentNameSchema.safeParse(normalized)
      if (bounded?.success === false) return Promise.reject(bounded.error)
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

  const followRecordedName = useCallback((name: string | null) => {
    const base = snapshotRef.current
    if (base === null || pendingSnapshotRef.current !== null || savePromiseRef.current !== null)
      return
    if (base.name === (name ?? base.path)) return
    snapshotRef.current = { ...base, name: name ?? base.path }
    setSnapshot(snapshotRef.current)
  }, [])

  const deleteDocument = useCallback(async () => {
    // Copy below names the document, and a note is not a canvas — kindNoun is
    // the single place that mapping lives (vocabulary.md).
    const noun = kindNoun(snapshotRef.current?.kind)
    // Abort if flush fails — unsaved edits must not be silently discarded.
    const flushed = await flushSave()
    if (!flushed) {
      throw new Error(`Your changes could not be saved. The ${noun} copy has been kept.`)
    }
    // Abort if a previous save already failed; data integrity is uncertain.
    if (persistenceRef.current.kind === 'degraded') {
      throw new Error(`The ${noun} could not be safely removed. Your copy has been kept.`)
    }
    const id = await pointerRef.current.get()
    if (id === null) return
    let removed: boolean
    try {
      const entry = await indexRef.current.resolveDocumentById({
        workspaceId: getBrowserWorkspaceId(),
        documentId: id,
      })
      removed = entry !== null // the pointer names nothing: silent no-op
      if (entry !== null) {
        // Cleared BEFORE the row goes, as `startFresh` does: a load between
        // the two would otherwise read a pointer naming nothing and say the
        // data could not be read, where a missing pointer opens cleanly.
        await pointerRef.current.clear()
        await indexRef.current.deleteDocument({
          workspaceId: getBrowserWorkspaceId(),
          path: entry.path,
        })
      }
    } catch {
      // Generic safe copy — do not expose raw IDB error
      throw new Error(`The ${noun} could not be removed. Your copy has been kept.`)
    }
    if (!removed) return
    // A switch in flight was aimed at a page that no longer holds this document.
    switchGenerationRef.current++
    try {
      const opened = await openWhatIsLeft({
        index: indexRef.current,
        pointer: pointerRef.current,
        clock: clockRef.current,
        loro: loroRef.current,
      })
      snapshotRef.current = opened
      setSnapshot(opened)
    } catch {
      // The delete stands; only the next open failed, so the page offers the
      // load-failed recovery rather than claiming the delete was refused.
      snapshotRef.current = null
      setSnapshot(null)
      setPersistenceRef.current({
        kind: 'degraded',
        reason: 'load-failed',
        message: 'The next document could not be opened.',
        lastSavedAt: null,
      })
    }
  }, [flushSave])

  const startFresh = useCallback(async () => {
    let fresh: DocumentSnapshot
    try {
      // Create BEFORE repointing, so a failed create never leaves the pointer
      // aimed at a document that does not exist (which would reload degraded).
      fresh = await createSeededDocument(indexRef.current, loroRef.current, clockRef.current)
      const existingId = await pointerRef.current.get()
      // Order does not matter here: deleting by path has no coupling to the
      // pointer, so the drop need not precede the repoint.
      if (existingId !== null && existingId !== fresh.documentId) {
        try {
          const stale = await indexRef.current.resolveDocumentById({
            workspaceId: getBrowserWorkspaceId(),
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
              workspaceId: getBrowserWorkspaceId(),
              path: stale.path,
            })
          }
        } catch {
          // Dropping the old document is best-effort; failure must not abort recovery.
        }
      }
      await pointerRef.current.set(fresh.documentId)
    } catch {
      // Recovery itself failed. No orphan cleanup is needed:
      // `createSeededDocument` rolls its own index row back when the content
      // write fails, and a failure after that point leaves a document that is
      // complete and simply not pointed at — which the next create numbers
      // around rather than trips over. The degraded view keeps the user on a
      // retry-able state instead of showing "Saved" over a dangling pointer.
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
  }, [])

  const listDocuments = useCallback((): Promise<DocumentSnapshot[]> => {
    return listBrowserDocuments(indexRef.current, clockRef.current)
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
      if (generation !== switchGenerationRef.current) return false // superseded; optimisation only
      if (!flushed) return false
      try {
        const loaded = await loadBrowserDocument(indexRef.current, id, clockRef.current)
        if (generation !== switchGenerationRef.current) return false // superseded while loading
        if (loaded === null) {
          // A missing target is a RECOVERABLE miss, not a degraded store: it
          // is exactly what a stale /local/:path bookmark produces, and parking
          // the page on a degraded screen would dead-end the user. Leave the
          // current document untouched and let the caller decide (the page
          // replaces the URL with the still-loaded document).
          //
          // There is no third outcome here: the index either holds the
          // document or it does not, and whether its CONTENT reads is
          // `LoroStore.load`'s answer to give, on the path that actually reads
          // bytes. A degraded branch here would say "could not be switched"
          // about a document that had switched.
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

  // What a duplicate IS lives in one place for both surfaces (the index row
  // has only a path); this side adds what only an open document owes —
  // flushing its pending save first, and moving the editor onto the copy.
  const duplicateDocument = useCallback(async (): Promise<DocumentSnapshot> => {
    const flushed = await flushSave()
    if (!flushed) throw new Error('Failed to save pending changes before duplicating.')
    const source = snapshotRef.current
    if (source === null) throw new Error('No canvas is open to duplicate.')

    const fresh = await duplicateBrowserDocument({
      index: indexRef.current,
      clock: clockRef.current,
      sourcePath: source.path,
    })

    await switchDocument(fresh.documentId)
    return fresh
  }, [flushSave, switchDocument])

  return {
    loro: loroRef.current,
    snapshot,
    persistence,
    renameDocument,
    followRecordedName,
    deleteDocument,
    startFresh,
    listDocuments,
    createDocument,
    switchDocument,
    duplicateDocument,
  }
}
