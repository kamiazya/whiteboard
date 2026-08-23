/**
 * The debounced auto-compaction scheduler.
 *
 * Lifted out of `document-store.ts`, which is about reading and writing
 * documents. This is a different thing wearing the same file: a background
 * scheduler with its own timers, its own in-flight tracking, its own disposal
 * protocol and its own two test seams. The store announces a save; this module subscribes.
 * The dependency runs one way — which was NOT true before the split, and is
 * what made the split more than a file move.
 *
 * That direction is why the DB dispose hook is registered HERE. It used to run
 * whenever `document-store.ts` loaded, which was early and often; it now runs
 * when this module loads — which is exactly when a compaction could first be
 * scheduled, since nothing can schedule one without importing this file.
 */

import { getLogger } from '../log.js'
import { registerDbDisposeHook } from './db/index.js'
import { compactDocument, setDocumentSavedListener } from './document-store.js'
import type { VersionStore } from './version-store.js'

// ── auto-compact debouncer ────────────────────────────────────────────
// saveDocument calls a registered trigger after every write. The route layer
// wires that trigger to scheduleAutoCompact below; tests can register a spy
// instead to verify call ordering. Per-canvas timers coalesce a burst of
// edits into a single compaction once the editing pause exceeds debounceMs.

// Shared by uninstallAutoCompact() and disposeAutoCompact() so the two
// cancellation paths can never drift out of sync with each other.
function clearAllAutoCompactTimers(): void {
  for (const t of autoCompactTimers.values()) clearTimeout(t)
  autoCompactTimers.clear()
}

/**
 * Subscribe to saves and debounce a compaction after each one.
 *
 * The `versionStore` is taken here rather than reached for inside, which is
 * why the store never had to know the concrete version-store type — that
 * indirection was the original reason for a registered trigger, and it
 * survives the split intact.
 */
export function installAutoCompact(versionStore: VersionStore): void {
  setDocumentSavedListener((workspaceId, path) => {
    scheduleAutoCompact(workspaceId, path, versionStore)
  })
}

/**
 * Stop compacting, and drain the timers that were already ticking.
 *
 * Synchronous by contract: it cancels timers that have not fired yet and
 * deliberately does NOT await in-flight compactions — `disposeAutoCompact` is
 * the superset that does. Uninstalling without clearing would leave a pending
 * timer to fire against a test's removed tempDir.
 */
export function uninstallAutoCompact(): void {
  setDocumentSavedListener(null)
  clearAllAutoCompactTimers()
}

const AUTO_COMPACT_DEBOUNCE_MS = 30_000
const autoCompactTimers = new Map<string, ReturnType<typeof setTimeout>>()

// Tracks compactDocument() calls that have already fired but not yet settled.
// A Set of the promises themselves (not a Map keyed by workspaceId/path) is
// required: two overlapping compactions for the same key must both stay
// tracked until they individually settle, since a keyed map with an
// unconditional delete-on-settle would let a still-in-flight entry get
// dropped by an unrelated compaction for the same key finishing first.
const inFlightAutoCompacts = new Set<Promise<unknown>>()

// True only for the duration of a disposeAutoCompact() call. An in-flight
// compaction's loadDocument() can run legacy migration, which calls
// saveDocument(), which re-invokes the registered auto-compact trigger and
// tries to schedule a fresh timer for the same key — see disposeAutoCompact's
// loop comment below. Without this guard, that reschedule's timer and
// disposeAutoCompact's next clear-and-recheck pass race each other: whichever
// one is scheduled first on the event loop wins, and under load the timer
// can fire (starting a real compaction) before the loop gets back around to
// cancel it. disposeAutoCompact's own loop still correctly waits for a
// compaction that wins that race, so this was never a leak, but the outcome
// was nondeterministic. Refusing new timers for the whole disposal removes
// the race instead of relying on winning it.
// A counter rather than a boolean: overlapping disposeAutoCompact() calls
// (parallel DB dispose hooks, test teardown racing an explicit call) must not
// let the first finisher drop the guard while another disposal is still
// draining.
let disposingAutoCompactCount = 0

export function scheduleAutoCompact(
  workspaceId: string,
  path: string,
  versionStore: VersionStore,
  options: { debounceMs?: number } = {},
): void {
  if (disposingAutoCompactCount > 0) return
  const key = `${workspaceId}/${path}`
  const existing = autoCompactTimers.get(key)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    autoCompactTimers.delete(key)
    const compaction = compactDocument(workspaceId, path, versionStore)
      .then((result) => {
        if (result.compacted) {
          getLogger('auto-compact').info(
            {
              workspaceId,
              path,
              beforeBytes: result.beforeBytes,
              afterBytes: result.afterBytes,
            },
            'compacted',
          )
        }
      })
      .catch((err) => {
        getLogger('auto-compact').warning({ workspaceId, path, err }, 'failed')
      })
      .finally(() => {
        inFlightAutoCompacts.delete(compaction)
      })
    inFlightAutoCompacts.add(compaction)
  }, options.debounceMs ?? AUTO_COMPACT_DEBOUNCE_MS)
  // Do not keep the event loop alive just for this debounce. Node will
  // still flush the compaction if anything else (HTTP, WS) holds the
  // loop open; in tests we explicitly wait for the timeout.
  if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref()
  }
  autoCompactTimers.set(key, timer)
}

// Awaitable superset of uninstallAutoCompact(): cancels every pending
// timer AND waits for every already-fired compaction to settle, so a caller
// that awaits this is guaranteed no compactDocument call can still reach the
// DB driver afterward. Registered as a DB dispose hook (below) so disposing
// a store's DB always drains this state first, without every dispose call
// site having to remember to call it manually. Idempotent: calling it with
// nothing pending simply resolves immediately, and scheduleAutoCompact works
// again afterward (a fresh call re-populates both trackers).
export async function disposeAutoCompact(): Promise<void> {
  disposingAutoCompactCount++
  try {
    // A single clear-then-await pass is not enough: an in-flight compaction's
    // loadDocument() can run legacy migration, which calls saveDocument(), which
    // re-invokes the registered auto-compact trigger *while we are still
    // awaiting the first batch*. scheduleAutoCompact refuses that reschedule
    // outright (the guard counter is non-zero for this whole call), so this
    // loop's job is just to drain whatever was already in flight or already
    // timer-scheduled before disposal began.
    for (;;) {
      clearAllAutoCompactTimers()
      const inFlight = Array.from(inFlightAutoCompacts)
      if (inFlight.length === 0) break
      await Promise.allSettled(inFlight)
    }
  } finally {
    disposingAutoCompactCount--
  }
}

// Test-only introspection: how many debounces are PENDING, as opposed to
// how many compactions are in flight. It is what lets a test assert that a
// write scheduled one — asserting only that the write did not throw is the
// proxy indicator that let the agent-write path go untriggered for so long.
export function _autoCompactTimerCountForTests(): number {
  return autoCompactTimers.size
}

// Test-only introspection, matching the `_destinationCountForTests` pattern
// in log.ts: lets tests poll for "a compaction has fired and is mid-flight"
// without a bespoke gate inside compactDocument itself.
export function _inFlightAutoCompactCountForTests(): number {
  return inFlightAutoCompacts.size
}

// Test-only introspection: lets a test deterministically wait until
// disposeAutoCompact() has begun (and is therefore refusing reschedules)
// before triggering a reschedule attempt, instead of racing a wall-clock
// delay against dispose's await window.
export function _isDisposingAutoCompactForTests(): boolean {
  return disposingAutoCompactCount > 0
}

registerDbDisposeHook(disposeAutoCompact)
