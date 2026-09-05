/**
 * When a markdown edit becomes a write, and what the save indicator says
 * while that is in flight.
 *
 * Extracted from `use-markdown-document` so the POLICY can be modelled apart
 * from React, IndexedDB and a real clock. It is worth separating because the
 * same 500ms debounce has now produced two defects in two consecutive PRs,
 * both of the same shape — a timer firing part-way through typing, and some
 * downstream state settling on the partial value:
 *
 *   - a save wait settled on a partial write and reported it as the latest
 *   - a document was named after a half-typed heading, permanently
 *
 * Neither is visible in a diff, and neither reproduces on an idle machine.
 * What they have in common is an INTERLEAVING, which is exactly what a
 * command-based model generates and a hand-written example does not.
 */
import type { Dispatch, SetStateAction } from 'react'
import type { BrowserPersistenceState } from '../lib/browser-persistence-state.js'
/** Whatever the host's timer handle is; opaque here so a test can use its own. */
export type SaveTimer = unknown

export interface SaveSchedulerDeps {
  /**
   * Binds a write to whatever the document is attached to RIGHT NOW, or
   * answers null when there is nothing to write through.
   *
   * Called when the write is ENQUEUED, never when it runs. The handle and
   * the content are captured at different moments and both matter: by the
   * time a queued write runs, the next document may already hold the handle,
   * so resolving it late writes through the wrong one. Doing that is what
   * broke `a reload sees the edits the unmount flush was still writing`.
   * What the write CONTAINS is still whatever the containers hold when it
   * runs, which is why `covers` below is read then and not here.
   */
  readonly beginSave: () => (() => Promise<void>) | null
  /** Publishes the state a save indicator renders. */
  readonly report: Dispatch<SetStateAction<BrowserPersistenceState>>
  /**
   * Runs `save` after whatever save is already in flight for this document.
   * Injected because the real queue is keyed by document id and shared with
   * the next load, which awaits it before reading.
   */
  readonly enqueue: (save: () => Promise<void>) => void
  readonly setTimer: (fire: () => void, ms: number) => SaveTimer
  readonly clearTimer: (timer: SaveTimer) => void
  readonly debounceMs: number
  /** The timestamp a landed write is stamped with. */
  readonly now: () => string
}

export interface SaveScheduler {
  /** An edit landed: unsaved from this instant, and the debounce restarts. */
  edit(): void
  /**
   * FLUSH, not cancel. A pending debounce holds edits that are already in the
   * document and already on screen; dropping it loses whatever was typed in
   * the last debounce period before a switch or unmount.
   */
  flush(): void
}

/**
 * Runs one write and reports what it means for the text ON SCREEN.
 *
 * `covers` is the load-bearing part. A write persists the document as it
 * stood when it STARTED, so an edit arriving while it is in flight is not in
 * it — and reporting `saved` on success then claims safety for text that is
 * nowhere but memory, until the next debounce elapses. Found by the model in
 * this file's companion test, on the sequence type / tick / type / settle.
 *
 * The write still landed, so its timestamp is still a fact and still
 * advances; only the KIND stays `pending`, which is what the newer edit
 * already made true and what its armed timer is about to resolve.
 */
async function reportingSave(
  deps: SaveSchedulerDeps,
  write: () => Promise<void>,
  covers: () => boolean,
): Promise<void> {
  deps.report((p) => ({ kind: 'saving', lastSavedAt: p.lastSavedAt }))
  try {
    await write()
    deps.report({ kind: covers() ? 'saved' : 'pending', lastSavedAt: deps.now() })
  } catch (err) {
    deps.report((p) => ({
      kind: 'degraded',
      reason: 'write-failed',
      message: 'The last write to this browser failed. Your edits stay in memory for this session.',
      lastSavedAt: p.lastSavedAt,
    }))
    throw err
  }
}

export function createSaveScheduler(deps: SaveSchedulerDeps): SaveScheduler {
  let timer: SaveTimer | null = null
  // Counts edits, so a completed write can tell whether it contains the text
  // that is on screen. Nothing reads the number itself.
  let edits = 0
  const run = () => {
    const write = deps.beginSave()
    if (write === null) return
    // Read when the write RUNS, not here: it persists whatever the document
    // holds at that moment, so that is the edit it covers.
    let at: number | null = null
    deps.enqueue(() => {
      at = edits
      return reportingSave(deps, write, () => at === edits)
    })
  }
  return {
    edit() {
      edits += 1
      if (timer !== null) deps.clearTimer(timer)
      // Unsaved from this instant, not from when the timer fires: the window
      // between the keystroke and the debounce is exactly when the old
      // indicator claimed everything was safe.
      deps.report((p) => ({ kind: 'pending', lastSavedAt: p.lastSavedAt }))
      timer = deps.setTimer(() => {
        // Cleared first, so a flush arriving after this point finds no timer
        // and this save has to enqueue itself, or the next load has nothing
        // to wait on.
        timer = null
        run()
      }, deps.debounceMs)
    },
    flush() {
      if (timer === null) return
      deps.clearTimer(timer)
      timer = null
      run()
    },
  }
}
