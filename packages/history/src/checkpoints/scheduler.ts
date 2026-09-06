/**
 * When a document's automatic checkpoint is taken.
 *
 * A TRAILING debounce, not an interval: a checkpoint lands once the document
 * has been quiet for `quietMs`. Two things follow from that, and both are the
 * point rather than a side effect.
 *
 * The first is what a row MEANS. A checkpoint at a fixed interval lands in
 * the middle of whatever was happening; a checkpoint at a pause lands where
 * a person stopped, which is where they would want to come back to.
 *
 * The second is cost. A save re-reads the document and counts its elements
 * — measured at 122ms for a 1000-node canvas on the daemon — so paying it
 * while someone is editing is the worst moment available, and paying it
 * once they have stopped is nearly free.
 *
 * What this replaced was a LEADING-edge throttle, and its defect was
 * structural rather than a matter of tuning: it ran only when an update
 * arrived, so it could never take a checkpoint after editing stopped. The
 * state a person leaves behind was the one state no checkpoint held.
 *
 * `ceilingMs` is the answer to the obvious hole: editing that never pauses
 * would otherwise never be checkpointed, so a session that has run that long
 * without one takes it anyway.
 *
 * The scheduler knows nothing about where a checkpoint goes: `save` is the
 * keeper's — the daemon's version store, the browser's IndexedDB rows — and
 * so is what to do when one fails.
 */
import type { LoroDoc } from 'loro-crdt'
import { frontiersToBase64 } from '../frontiers-base64.js'

/** The pause after which a document is considered settled. */
export const CHECKPOINT_QUIET_MS = 5 * 60_000
/** How long editing may run with no pause before a checkpoint is taken regardless. */
export const CHECKPOINT_CEILING_MS = 30 * 60_000

export interface CheckpointSchedulerOptions<Entry> {
  readonly quietMs?: number
  readonly ceilingMs?: number
  /** Writes the checkpoint; `branchName` is what `getHeadBranch` answered, or null. */
  readonly save: (
    workspaceId: string,
    path: string,
    doc: LoroDoc,
    branchName: string | null,
  ) => Promise<Entry>
  /**
   * Resolves the HEAD branch at save time so the row can carry it. Omitted
   * (or answering null) leaves the keeper's save to its own default.
   */
  readonly getHeadBranch?: (workspaceId: string, path: string) => Promise<string | null>
  /**
   * Called when a checkpoint actually lands. The trigger does not answer its
   * caller with an entry — the save happens long after the update that
   * signalled it — so this is how a broadcast reaches the surfaces watching.
   */
  readonly onSaved?: (workspaceId: string, path: string, entry: Entry) => void
  /** A save (or a fatal head lookup) failed; the keeper logs it its own way. */
  readonly onError: (err: unknown, at: { workspaceId: string; path: string }) => void
  /**
   * A `getHeadBranch` failure that must NOT be absorbed into "no branch":
   * corrupt stored data is one — the checkpoint would otherwise be filed
   * under `main` and hide it.
   */
  readonly isFatal?: (err: unknown) => boolean
}

export interface CheckpointScheduler {
  /** "This document just changed." Cheap, synchronous, and safe to call per update. */
  (workspaceId: string, path: string, doc: LoroDoc): void
  /** Take every pending checkpoint now, and wait for them. For a session ending. */
  flush(): Promise<void>
  /** Drop every pending checkpoint without taking it. */
  stop(): void
}

interface Pending {
  timer: ReturnType<typeof setTimeout>
  doc: LoroDoc
  /** When the run of edits this checkpoint would cover began. */
  since: number
}

export function createCheckpointScheduler<Entry>(
  options: CheckpointSchedulerOptions<Entry>,
): CheckpointScheduler {
  const quietMs = options.quietMs ?? CHECKPOINT_QUIET_MS
  const ceilingMs = options.ceilingMs ?? CHECKPOINT_CEILING_MS
  // In-place Map mutation is intentional throughout: this is closure-private
  // scheduler state, never shared or observed, so the immutability rule
  // (which guards shared/observable data) does not apply.
  const pending = new Map<string, Pending>()
  /** The frontier each key was last checkpointed at — the diff check. */
  const savedAt = new Map<string, string>()
  const inFlight = new Set<Promise<unknown>>()

  async function take(workspaceId: string, path: string, doc: LoroDoc): Promise<void> {
    const key = `${workspaceId}/${path}`
    // Encoding a frontier is free (measured at 0ms), so the "has anything
    // changed" question costs nothing and a quiet document writes no row.
    const now = frontiersToBase64(doc.oplogFrontiers())
    if (savedAt.get(key) === now) return

    let branchName: string | null = null
    if (options.getHeadBranch) {
      try {
        branchName = await options.getHeadBranch(workspaceId, path)
      } catch (err) {
        if (options.isFatal?.(err)) throw err
        branchName = null
      }
    }
    const entry = await options.save(workspaceId, path, doc, branchName)
    // Recorded only after the save succeeded: a failed checkpoint must leave
    // the next edit free to try again rather than looking already covered.
    savedAt.set(key, now)
    options.onSaved?.(workspaceId, path, entry)
  }

  function fire(key: string, workspaceId: string, path: string): void {
    const entry = pending.get(key)
    if (entry === undefined) return
    pending.delete(key)
    clearTimeout(entry.timer)
    const run = take(workspaceId, path, entry.doc)
      .catch((err: unknown) => options.onError(err, { workspaceId, path }))
      .finally(() => {
        inFlight.delete(run)
      })
    inFlight.add(run)
  }

  const trigger = ((workspaceId: string, path: string, doc: LoroDoc): void => {
    const key = `${workspaceId}/${path}`
    const existing = pending.get(key)
    const since = existing?.since ?? Date.now()
    if (existing) clearTimeout(existing.timer)

    // The ceiling is measured from the START of this run of edits, so a
    // session that never pauses still gets checkpoints at that cadence
    // rather than one at the very end.
    const wait = Math.max(0, Math.min(quietMs, since + ceilingMs - Date.now()))
    const timer = setTimeout(() => fire(key, workspaceId, path), wait)
    // Never hold a Node event loop open for a debounce; anything real keeps
    // it alive on its own, and a shutdown flushes explicitly. A browser timer
    // has no `unref`, which is what the guard is for.
    if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
      timer.unref()
    }
    pending.set(key, { timer, doc, since })
  }) as CheckpointScheduler

  trigger.flush = async (): Promise<void> => {
    for (const [key, entry] of [...pending]) {
      const slash = key.indexOf('/')
      clearTimeout(entry.timer)
      fire(key, key.slice(0, slash), key.slice(slash + 1))
    }
    await Promise.all([...inFlight])
  }

  trigger.stop = (): void => {
    for (const entry of pending.values()) clearTimeout(entry.timer)
    pending.clear()
  }

  return trigger
}
