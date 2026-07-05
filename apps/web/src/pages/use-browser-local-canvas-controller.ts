import { useState, useEffect, useRef, useCallback } from 'react'
import type { BrowserLocalStore } from '../lib/browser-local-store.js'
import type { CanvasSnapshot } from '../lib/whiteboard-client.js'

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
  updateScene(elements: unknown[]): void
  renameCanvas(name: string): void
  triggerCleanup(): Promise<void>
  startFresh(): Promise<void>
}

const DEBOUNCE_MS = 1000

export function useBrowserLocalCanvasController(
  store: BrowserLocalStore,
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
  const setPersistenceRef = useRef(setPersistence)
  setPersistenceRef.current = setPersistence
  const persistenceRef = useRef(persistence)
  persistenceRef.current = persistence
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const pendingSnapshotRef = useRef<CanvasSnapshot | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Returns true if there was nothing to flush or the flush succeeded.
  // Returns false if a pending save failed — callers that depend on data
  // integrity (e.g. triggerCleanup) must abort when this returns false.
  const flushSave = useCallback(async (): Promise<boolean> => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const snap = pendingSnapshotRef.current
    if (snap === null) return true
    pendingSnapshotRef.current = null
    setPersistenceRef.current((p) => ({ kind: 'saving', lastSavedAt: p.lastSavedAt ?? null }))
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
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function load() {
      let id = await storeRef.current.getDefaultCanvasId()
      if (cancelled) return

      if (id === null) {
        id = storeRef.current.generateId()
        const newSnapshot: CanvasSnapshot = {
          id,
          name: 'untitled',
          scene: { elements: [] },
          updatedAt: new Date().toISOString(),
        }
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

  const updateScene = useCallback(
    (elements: unknown[]) => {
      setSnapshot((prev) => {
        if (prev === null) return prev
        const updated: CanvasSnapshot = {
          ...prev,
          scene: { elements },
          updatedAt: new Date().toISOString(),
        }
        pendingSnapshotRef.current = updated
        return updated
      })
      setPersistenceRef.current((p) => ({ kind: 'pending', lastSavedAt: p.lastSavedAt ?? null }))
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        void flushSave()
      }, DEBOUNCE_MS)
    },
    [flushSave],
  )

  // Discrete edit — flush immediately instead of the scene debounce so a rename
  // never lingers as "Unsaved changes" and survives a fast reload.
  const renameCanvas = useCallback(
    (name: string) => {
      // Merge with the freshest pending snapshot (e.g. a concurrent updateScene)
      // instead of committed state, so neither edit clobbers the other. Computed
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
    const fresh: CanvasSnapshot = {
      id,
      name: 'untitled',
      scene: { elements: [] },
      updatedAt: new Date().toISOString(),
    }
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

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current)
    }
  }, [])

  return {
    snapshot,
    persistence,
    cleanupCompleted,
    cleanupError,
    updateScene,
    renameCanvas,
    triggerCleanup,
    startFresh,
  }
}
