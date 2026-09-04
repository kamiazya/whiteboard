import { encodeFrontiers, type LoroDoc } from 'loro-crdt'
import { getLogger } from '../../log.js'
import { isCorruptStoredDataError } from '../../store/corrupt-stored-data.js'
import type { OperatorInfo, VersionEntry, VersionStore } from '../../store/version-store.js'

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
 * The second is cost. A save re-reads the document and counts its elements —
 * measured at 122ms for a 1000-node canvas — so paying it while someone is
 * editing is the worst moment available, and paying it once they have
 * stopped is nearly free.
 *
 * What this replaces was a LEADING-edge throttle, and its defect was
 * structural rather than a matter of tuning: it ran only when an update
 * arrived, so it could never take a checkpoint after editing stopped. The
 * state a person leaves behind was the one state no checkpoint held.
 * `auto-version-timing.test.ts` holds the measurement.
 *
 * `ceilingMs` is the answer to the obvious hole: editing that never pauses
 * would otherwise never be checkpointed, so a session that has run that long
 * without one takes it anyway.
 */

/** The pause after which a document is considered settled. */
export const AUTO_VERSION_QUIET_MS = 5 * 60_000
/** How long editing may run with no pause before a checkpoint is taken regardless. */
export const AUTO_VERSION_CEILING_MS = 30 * 60_000

export interface AutoVersionOptions {
  readonly quietMs?: number
  readonly ceilingMs?: number
  /**
   * Resolves the HEAD branch at save time and writes it into the version's
   * meta. Omitted (or answering null) leaves `VersionStore.save` to fall back
   * to "main", which is the behaviour every caller had before branches.
   */
  readonly getHeadBranch?: (workspaceId: string, path: string) => Promise<string | null>
  /**
   * Called when a checkpoint actually lands. The trigger no longer answers
   * its caller with an entry — the save happens long after the update that
   * signalled it — so this is how a broadcast reaches the surfaces watching.
   */
  readonly onSaved?: (workspaceId: string, path: string, entry: VersionEntry) => void
}

export interface AutoVersionTrigger {
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
  /** When the run of edits that this checkpoint would cover began. */
  since: number
}

function frontierKey(doc: LoroDoc): string {
  return Buffer.from(encodeFrontiers(doc.oplogFrontiers())).toString('base64')
}

export function createAutoVersionTrigger(
  versionStore: VersionStore,
  options: AutoVersionOptions = {},
): AutoVersionTrigger {
  const quietMs = options.quietMs ?? AUTO_VERSION_QUIET_MS
  const ceilingMs = options.ceilingMs ?? AUTO_VERSION_CEILING_MS
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
    const now = frontierKey(doc)
    if (savedAt.get(key) === now) return

    let branchName: string | null = null
    if (options.getHeadBranch) {
      try {
        branchName = await options.getHeadBranch(workspaceId, path)
      } catch (err) {
        if (isCorruptStoredDataError(err)) throw err
        branchName = null
      }
    }
    const opts: { auto: boolean; branchName?: string; operator: OperatorInfo } = {
      auto: true,
      operator: { kind: 'system', peerId: doc.peerIdStr, displayName: 'auto-save' },
    }
    if (typeof branchName === 'string' && branchName.length > 0) opts.branchName = branchName

    const entry = await versionStore.save(workspaceId, path, doc, opts)
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
      .catch((err: unknown) => {
        getLogger('auto-version').error({ workspaceId, path, err: err as Error }, 'save failed')
      })
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
    // Never hold the event loop open for a debounce; anything real (HTTP, WS)
    // keeps it alive on its own, and a shutdown flushes explicitly.
    if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
      timer.unref()
    }
    pending.set(key, { timer, doc, since })
  }) as AutoVersionTrigger

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
