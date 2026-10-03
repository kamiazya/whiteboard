import type { VersionEntry } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { type CheckpointScheduler, createCheckpointScheduler } from '@kamiazya/whiteboard-history'
import { useEffect, useMemo } from 'react'
import { getAppLogger } from '../lib/app-logger.js'
import type { BrowserVersionStore } from '../lib/browser-version-store.js'
import type { VersionsRecordSeam } from '../lib/browser-versions-backend.js'
import { browserWorkspaceIdOrNull, getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'
import { listenToWorkspace, type WorkspaceBroadcast } from '../lib/workspace-broadcast.js'

const log = getAppLogger('browser-document-page')

/**
 * The two ways an automatic checkpoint lands, handed to whoever can trigger
 * them: `signal` on every local edit, `flush` when the page goes away.
 */
export interface CheckpointPair {
  readonly signal: () => void
  readonly flush: () => void
}

/** Where a document at `path` is once `from` (it, or a folder above it) has become `to`. */
function pathAfterMove(path: string, from: string, to: string): string {
  if (path === from) return to
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path
}

interface LivePath {
  path: string | null
  /** Where the document was when it was deleted, until it comes back. */
  removedAt: string | null
}

/**
 * Where a document is now, which a restore needs to tell apart from some other
 * document returning: it comes back under the path it was deleted from.
 */
function followBroadcast(
  checkpoints: CheckpointScheduler,
  workspaceId: string,
  live: LivePath,
  message: WorkspaceBroadcast,
): void {
  if (message.type === 'document-moved') {
    checkpoints.moved(workspaceId, message.from, message.to)
    if (live.path !== null) live.path = pathAfterMove(live.path, message.from, message.to)
  } else if (message.type === 'document-removed') {
    checkpoints.removed(workspaceId, message.path)
    if (live.path === message.path) {
      live.removedAt = live.path
      live.path = null
    }
  } else if (message.type === 'document-restored' && live.removedAt === message.path) {
    live.path = message.path
    live.removedAt = null
  }
}

function useLivePath(
  checkpoints: CheckpointScheduler,
  documentPath: string | null,
  listen: typeof listenToWorkspace,
): LivePath {
  // Where this document lives NOW, which the page's snapshot does not say: it
  // is read once, at load, while the files panel — here or in another tab —
  // can move or delete the document under a pending checkpoint. A checkpoint
  // is keyed by path and the store resolves that path when it saves, so one
  // left under the old name fails against a path that no longer exists.
  // Null while the document is gone: nothing is left to record, and arming
  // another would only report a failure for an operation that succeeded.
  // Keyed on the scheduler and the path it was seeded from, so it starts over
  // with whatever document the page switches to. Updated in place: nothing
  // renders from it, and a render per move would only re-create the pair.
  const live = useMemo<LivePath>(
    () => ({ path: documentPath, removedAt: null }),
    [checkpoints, documentPath],
  )
  useEffect(() => {
    // A page that mounts before the workspace resolves has no record to hear.
    const workspaceId = browserWorkspaceIdOrNull()
    if (workspaceId === null) return undefined
    const end = listen(workspaceId, (message) =>
      followBroadcast(checkpoints, workspaceId, live, message),
    )
    return () => end.close()
  }, [checkpoints, live, listen])
  return live
}

function armCheckpoint(
  recordSource: VersionsRecordSeam | null,
  checkpoints: CheckpointScheduler,
  live: { readonly path: string | null },
): () => void {
  return () => {
    // A document with no path yet has nowhere to file a row; the record
    // is what a checkpoint points at, so both must be there.
    const path = live.path
    if (path === null) return
    // Total, and deliberately so. This runs inside Loro's local-update
    // subscriber, where a throw does not fail the edit — it escapes as an
    // UNHANDLED REJECTION, which vitest reports as `Errors 1` with every
    // test still passing and only the exit code red. A missed checkpoint is
    // not worth that, and nothing here is worth failing an edit for either:
    // a seam that cannot answer for a record has no record to bookmark.
    try {
      const record = recordSource?.readRecord?.((doc) => doc) ?? null
      if (record !== null) checkpoints(getBrowserWorkspaceId(), path, record)
    } catch (err) {
      log.warn('could not arm an automatic checkpoint', err)
    }
  }
}

/**
 * Automatic checkpoints for the browser keeper, on the same mechanic the
 * daemon runs (`@kamiazya/whiteboard-history`): a trailing debounce that lands
 * a point once the document has been quiet, so a row marks where a person
 * stopped rather than an arbitrary interval.
 *
 * The `doc` the scheduler is handed is the WORKSPACE RECORD, not this
 * document's content — it uses the frontier only to ask "has anything changed
 * since the last checkpoint", and the record's frontier is what the store
 * saves. Keying on the content doc would compare a frontier against a row
 * taken from a different one, and never match.
 *
 * `recordSource` is a seam rather than a backend because only one kind of
 * document has one: a markdown note deliberately has no backend, and the hook
 * that owns its doc supplies the seam instead. Reading `backend` alone here is
 * what left a note arming no checkpoint ever.
 */
/**
 * Every flush still in flight. A flush outlives the page that fired it (an
 * unmount cannot await), so a test that tears a page down and then deletes
 * the database would otherwise race the checkpoint it just released — the
 * save then finds no record and warns, in whichever test happens to be
 * running. `settleAutoCheckpoints` is the one thing a test may await before
 * clearing storage; production never needs it, since nothing there deletes
 * the database under a page it has just left.
 */
const inFlight = new Set<Promise<void>>()

function trackFlush(flush: Promise<void>): void {
  const settled = flush.catch(() => {}).finally(() => inFlight.delete(settled))
  inFlight.add(settled)
}

export async function settleAutoCheckpoints(): Promise<void> {
  // Sequential on purpose: a flush that lands while we wait may add another.
  while (inFlight.size > 0) await Promise.all(inFlight)
}

export function useAutoCheckpoint(
  recordSource: VersionsRecordSeam | null,
  versionStore: Pick<BrowserVersionStore, 'save' | 'isUnchangedSinceLastVersion'>,
  documentPath: string | null,
  listen: typeof listenToWorkspace = listenToWorkspace,
): CheckpointPair {
  const checkpoints = useMemo(() => {
    return createCheckpointScheduler<VersionEntry>({
      alreadyCheckpointed: (w, p) => versionStore.isUnchangedSinceLastVersion(w, p),
      save: (workspaceId, path) =>
        versionStore.save(workspaceId, path, {
          auto: true,
          // The person at this browser is not who took this one.
          operator: { kind: 'system', displayName: 'auto-save' },
        }),
      onError: (err) => log.warn('automatic checkpoint failed', err),
    })
    // Re-created per record source, so nothing pending outlives leaving this
    // document for another (the effect below takes the outgoing one's).
  }, [recordSource, versionStore])

  // Leaving a document inside its quiet window is a person finishing with it,
  // so the pause it was waiting for is taken now — the way a tab closing
  // takes it — rather than dropped. `flush` also clears the timers it fires,
  // so nothing is left armed on a page that is gone.
  useEffect(() => () => trackFlush(checkpoints.flush()), [checkpoints])

  const live = useLivePath(checkpoints, documentPath, listen)

  // Bound to the record the seam holds, and a no-op until one is there.
  return useMemo(() => {
    const signal = armCheckpoint(recordSource, checkpoints, live)
    return {
      signal,
      // Signal, THEN flush. The session flushes the pending edit before
      // calling this, but the commit that performs reaches
      // `subscribeLocalUpdates` — where `signal` lives — only on a later
      // microtask, so flushing alone finds nothing armed and a person who
      // edits and closes the tab leaves no checkpoint. Signalling here arms
      // it against the record as it stands, which is what a checkpoint
      // points at anyway: the store saves the frontier that is ON DISK, so
      // an edit still in flight is simply not part of this point, rather
      // than making it wrong.
      flush: () => {
        signal()
        trackFlush(checkpoints.flush())
      },
    }
  }, [recordSource, checkpoints, live])
}
