import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import { LoroStore } from '../lib/loro-store.js'
import type { CanvasSnapshot } from '../lib/whiteboard-client.js'

// Narrow surface used by the controller to seed a new canvas's Loro doc.
// Injectable so node/jsdom tests can supply an in-memory fake instead of
// touching real IndexedDB or the loro-crdt library directly.
export interface LoroStoreLike {
  save(canvasId: string, snapshot: Uint8Array): Promise<void>
  createEmptySnapshot(): Uint8Array
}

export type BrowserLocalPersistenceState =
  | { kind: 'saved'; lastSavedAt: null | string }
  | { kind: 'pending'; lastSavedAt: null | string }
  | { kind: 'saving'; lastSavedAt: null | string }
  | { kind: 'degraded'; reason: string; message: string; lastSavedAt: null | string }

export interface BrowserLocalCanvasController {
  snapshot: CanvasSnapshot | null
  persistence: BrowserLocalPersistenceState
  cleanupCompleted: boolean
  cleanupError: string | null
  renameCanvas(name: string): void
  triggerCleanup(): Promise<void>
  startFresh(): Promise<void>
  listCanvases(): Promise<CanvasSnapshot[]>
  createCanvas(name?: string): Promise<CanvasSnapshot>
  switchCanvas(id: string): Promise<void>
}

function createCanvasSnapshot(id: string, name?: string): CanvasSnapshot {
  return { id, name: name?.trim() || 'untitled', updatedAt: new Date().toISOString() }
}

export function useBrowserLocalCanvasController(
  store: BrowserLocalStore,
  loro: LoroStoreLike = new LoroStore(),
): BrowserLocalCanvasController {
  const [snapshot, setSnapshot] = useState<CanvasSnapshot | null>(null)
  const [persistence, setPersistence] = useState<BrowserLocalPersistenceState>({
    kind: 'saved',
    lastSavedAt: null,
  })
  const [cleanupCompleted, setCleanupCompleted] = useState(false)
  const [cleanupError, setCleanupError] = useState<string | null>(null)

  // Stable refs so timer callbacks always see current state without re-creating
  const storeRef = useRef(store)
  storeRef.current = store
  const loroRef = useRef(loro)
  loroRef.current = loro
  const setPersistenceRef = useRef(setPersistence)
  setPersistenceRef.current = setPersistence
  const persistenceRef = useRef(persistence)
  persistenceRef.current = persistence
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const pendingSnapshotRef = useRef<CanvasSnapshot | null>(null)
  // Tracks the currently in-flight flush so overlapping callers (renameCanvas's
  // fire-and-forget flush racing with switchCanvas's own awaited flush) serialize
  // on the real outcome instead of the second caller observing an already-cleared
  // pendingSnapshotRef and returning true before the first save actually settles.
  const savePromiseRef = useRef<Promise<boolean> | null>(null)

  // Returns true if there was nothing to flush or the flush succeeded.
  // Returns false if a pending save failed — callers that depend on data
  // integrity (e.g. triggerCleanup, switchCanvas) must abort when this returns false.
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
          await storeRef.current.save(snap)
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
      let id = await storeRef.current.getDefaultCanvasId()
      if (cancelled) return

      if (id === null) {
        id = storeRef.current.generateId()
        const newSnapshot = createCanvasSnapshot(id)
        await storeRef.current.setDefaultCanvasId(id)
        await storeRef.current.save(newSnapshot)
        if (!cancelled) setSnapshot(newSnapshot)
        return
      }

      const result = await storeRef.current.load(id)
      if (cancelled) return
      if (result.kind === 'ok') {
        setSnapshot(result.snapshot)
      } else {
        // corrupted or not-found: generic safe copy, no raw error
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
  const renameCanvas = useCallback(
    (name: string) => {
      // Merge with the freshest pending snapshot instead of committed state, so
      // a concurrent edit in flight is never clobbered. Computed
      // from refs (not a setState updater) so pendingSnapshotRef is guaranteed
      // current before the immediate flushSave below reads it.
      const base = pendingSnapshotRef.current ?? snapshotRef.current
      if (base === null) return
      const normalized = name.trim() || 'untitled'
      const updated: CanvasSnapshot = {
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
      void flushSave()
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
    const id = await storeRef.current.getDefaultCanvasId()
    if (id === null) return
    try {
      const result = await storeRef.current.del(id)
      if (!result.deleted) return // pointer-mismatch or not-found: silent no-op
      setSnapshot(null)
      setCleanupCompleted(true)
    } catch {
      // Generic safe copy — do not expose raw IDB error
      setCleanupError('The canvas could not be removed. Your copy has been kept.')
    }
  }, [flushSave])

  const startFresh = useCallback(async () => {
    setCleanupError(null)
    const id = storeRef.current.generateId()
    const fresh = createCanvasSnapshot(id)
    try {
      // Save the new canvas BEFORE repointing the default id, so a failed write never
      // leaves the pointer aimed at an unsaved canvas (which would reload as degraded).
      await storeRef.current.save(fresh)
      const existingId = await storeRef.current.getDefaultCanvasId()
      // del() only removes the canvas the default pointer currently aims at (and clears
      // the pointer as it goes), so the old canvas must be dropped BEFORE repointing —
      // calling it after setDefaultCanvasId(id) always pointer-mismatches and leaks the row.
      if (existingId !== null && existingId !== id) {
        try {
          await storeRef.current.del(existingId)
        } catch {
          // Dropping the old canvas is best-effort; failure must not abort recovery.
        }
      }
      await storeRef.current.setDefaultCanvasId(id)
    } catch {
      // Recovery itself failed. If the failure landed on the final setDefaultCanvasId, the
      // freshly-saved canvas is written but never pointed to — del() can't reach it (it only
      // removes the current default), so drop the orphan via the pointer-independent
      // removeCanvas. Best-effort: cleanup failure must not mask the degraded view, which
      // keeps the user on a retry-able state instead of showing "Saved" over a dangling pointer.
      try {
        await storeRef.current.removeCanvas?.(id)
      } catch {
        // Orphan cleanup is best-effort; leaving a stray empty record is harmless.
      }
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

  const listCanvases = useCallback((): Promise<CanvasSnapshot[]> => {
    return storeRef.current.listCanvases()
  }, [])

  const createCanvas = useCallback(async (name?: string): Promise<CanvasSnapshot> => {
    const id = storeRef.current.generateId()
    const fresh = createCanvasSnapshot(id, name)
    // Metadata first, then the Loro doc: if the Loro write fails, the
    // metadata row is rolled back so a failed create never leaves an
    // orphan metadata row with no backing Loro doc.
    await storeRef.current.save(fresh)
    try {
      await loroRef.current.save(id, loroRef.current.createEmptySnapshot())
    } catch (err) {
      try {
        await storeRef.current.removeCanvas?.(id)
      } catch {
        // Orphan cleanup is best-effort; leaving a stray metadata row is harmless.
      }
      throw err
    }
    return fresh
  }, [])

  const switchCanvas = useCallback(
    async (id: string): Promise<void> => {
      // Flush any pending edit on the current canvas before switching away
      // from it, so a fast switch never drops an in-flight rename.
      const flushed = await flushSave()
      if (!flushed) return
      try {
        const result = await storeRef.current.load(id)
        if (result.kind !== 'ok') {
          // Target record is missing or unreadable: surface it the same way the
          // initial-mount load does, instead of leaving the user with no feedback
          // for why the switch silently did nothing. Current snapshot and default
          // pointer are left untouched — the still-current canvas view is not corrupted.
          setPersistenceRef.current((p) => ({
            kind: 'degraded',
            reason: 'switch-failed',
            message: 'The canvas could not be switched.',
            lastSavedAt: p.lastSavedAt ?? null,
          }))
          return
        }
        await storeRef.current.setDefaultCanvasId(id)
        snapshotRef.current = result.snapshot
        setSnapshot(result.snapshot)
        // Clear any stale degraded banner left over from the previous canvas —
        // a successful switch to a freshly-loaded, in-sync canvas should not keep
        // showing an error from before the switch.
        setPersistenceRef.current({ kind: 'saved', lastSavedAt: new Date().toISOString() })
      } catch {
        // Generic safe copy — do not expose raw IndexedDB error. Current
        // snapshot and default pointer are left untouched: a failed switch
        // must not corrupt the still-current canvas view.
        setPersistenceRef.current((p) => ({
          kind: 'degraded',
          reason: 'switch-failed',
          message: 'The canvas could not be switched.',
          lastSavedAt: p.lastSavedAt ?? null,
        }))
      }
    },
    [flushSave],
  )

  return {
    snapshot,
    persistence,
    cleanupCompleted,
    cleanupError,
    renameCanvas,
    triggerCleanup,
    startFresh,
    listCanvases,
    createCanvas,
    switchCanvas,
  }
}
