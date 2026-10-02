import { type CheckpointScheduler, createCheckpointScheduler } from '@kamiazya/whiteboard-history'
import { getLogger } from '../log.js'
import type { OperatorInfo, VersionEntry, VersionStore } from './version-store.js'

/**
 * The daemon's automatic checkpoints: the shared scheduler
 * (`@kamiazya/whiteboard-history`'s trailing debounce with a ceiling — the
 * reasoning behind the cadence and the measurement that chose it live
 * there) over this keeper's `VersionStore`, its logger, and its notion of a
 * fatal head lookup.
 *
 * `auto-version-timing.test.ts` holds the timing measurement against this
 * wiring.
 */

export interface AutoVersionOptions {
  readonly quietMs?: number
  readonly ceilingMs?: number
  /**
   * Called when a checkpoint actually lands. The trigger no longer answers
   * its caller with an entry — the save happens long after the update that
   * signalled it — so this is how a broadcast reaches the surfaces watching.
   */
  readonly onSaved?: (workspaceId: string, path: string, entry: VersionEntry) => void
  /** This daemon as an OKF actor — see `VersionsRouterOptions.daemonActor`. */
  readonly daemonActor?: string
}

export type AutoVersionTrigger = CheckpointScheduler

export function createAutoVersionTrigger(
  versionStore: VersionStore,
  options: AutoVersionOptions = {},
): AutoVersionTrigger {
  const { daemonActor } = options
  return createCheckpointScheduler<VersionEntry>({
    ...(options.quietMs === undefined ? {} : { quietMs: options.quietMs }),
    ...(options.ceilingMs === undefined ? {} : { ceilingMs: options.ceilingMs }),
    ...(options.onSaved === undefined ? {} : { onSaved: options.onSaved }),
    // The rows are the authority on "has anything changed since the last
    // checkpoint" — a per-process memory is empty after a restart and stale
    // after a save this scheduler did not make (a person's bookmark, a
    // restore), and both write a row over an unchanged document.
    alreadyCheckpointed: (workspaceId, path) =>
      versionStore.isUnchangedSinceLastVersion(workspaceId, path),
    save: (workspaceId, path, doc) => {
      const opts: { auto: boolean; operator: OperatorInfo } = {
        auto: true,
        operator: {
          kind: 'system',
          ...(daemonActor === undefined ? {} : { actor: daemonActor }),
          displayName: 'auto-save',
        },
      }
      return versionStore.save(workspaceId, path, doc, opts)
    },
    onError: (err, { workspaceId, path }) => {
      getLogger('auto-version').error({ workspaceId, path, err: err as Error }, 'save failed')
    },
  })
}
