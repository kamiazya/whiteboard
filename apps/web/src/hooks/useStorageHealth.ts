/**
 * `storageHealthOf` with a clock. Tracks when the document became unsaved
 * and re-judges at the threshold without waiting for a render — a page that
 * stops re-rendering the moment the person stops typing is exactly when a
 * stuck write has to be noticed.
 */
import { useEffect, useRef, useState } from 'react'
import type { BrowserPersistenceState } from '../lib/browser-persistence-state.js'
import { STUCK_AFTER_MS, type StorageHealth, storageHealthOf } from '../lib/storage-health.js'

export function useStorageHealth(state: BrowserPersistenceState): StorageHealth {
  // When the document last left `saved`. Held in a ref rather than derived
  // per render, because the moment matters and a render does not carry it:
  // re-rendering every keystroke must not keep moving the threshold away.
  const unsavedSince = useRef<number | null>(state.kind === 'saved' ? null : Date.now())
  if (state.kind === 'saved') unsavedSince.current = null
  else if (unsavedSince.current === null) unsavedSince.current = Date.now()

  // Only to re-run the judgement once the threshold passes.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (state.kind === 'saved' || state.kind === 'degraded') return
    const since = unsavedSince.current
    if (since === null) return
    const remaining = since + STUCK_AFTER_MS - Date.now()
    if (remaining <= 0) return
    const timer = setTimeout(() => setTick((n) => n + 1), remaining)
    return () => clearTimeout(timer)
  }, [state])

  return storageHealthOf(state, unsavedSince.current, Date.now())
}
