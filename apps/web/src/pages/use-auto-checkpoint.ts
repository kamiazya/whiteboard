import type { VersionEntry } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'
import { createCheckpointScheduler } from '@kamiazya/whiteboard-history'
import { useEffect, useMemo } from 'react'
import { getAppLogger } from '../lib/app-logger.js'
import type { BrowserVersionStore } from '../lib/browser-version-store.js'
import type { VersionsRecordSeam } from '../lib/browser-versions-backend.js'
import { getBrowserWorkspaceId } from '../lib/browser-workspace-id.js'

const log = getAppLogger('browser-document-page')

/**
 * The two ways an automatic checkpoint lands, handed to whoever can trigger
 * them: `signal` on every local edit, `flush` when the page goes away.
 */
export interface CheckpointPair {
  readonly signal: () => void
  readonly flush: () => void
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
export function useAutoCheckpoint(
  recordSource: VersionsRecordSeam | null,
  versionStore: BrowserVersionStore,
  documentPath: string | null,
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
    // Re-created per record source, so nothing pending survives leaving this
    // document for another (the effect below stops the outgoing one).
  }, [recordSource, versionStore])

  // Nothing pending survives leaving this document for another.
  useEffect(() => () => checkpoints.stop(), [checkpoints])

  // Bound to the record the seam holds, and a no-op until one is there.
  return useMemo(() => {
    const signal = (): void => {
      // A document with no path yet has nowhere to file a row; the record
      // is what a checkpoint points at, so both must be there.
      if (documentPath === null) return
      // Total, and deliberately so. This runs inside Loro's local-update
      // subscriber, where a throw does not fail the edit — it escapes as an
      // UNHANDLED REJECTION, which vitest reports as `Errors 1` with every
      // test still passing and only the exit code red. A missed checkpoint is
      // not worth that, and nothing here is worth failing an edit for either:
      // a seam that cannot answer for a record has no record to bookmark.
      try {
        const record = recordSource?.readRecord?.((doc) => doc) ?? null
        if (record !== null) checkpoints(getBrowserWorkspaceId(), documentPath, record)
      } catch (err) {
        log.warn('could not arm an automatic checkpoint', err)
      }
    }
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
        void checkpoints.flush()
      },
    }
  }, [recordSource, checkpoints, documentPath])
}
