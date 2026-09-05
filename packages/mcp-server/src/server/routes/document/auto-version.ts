import {
  CHECKPOINT_CEILING_MS,
  CHECKPOINT_QUIET_MS,
  type CheckpointScheduler,
  createCheckpointScheduler,
} from '@kamiazya/whiteboard-history'
import type { LoroDoc } from 'loro-crdt'
import { getLogger } from '../../log.js'
import { isCorruptStoredDataError } from '../../store/corrupt-stored-data.js'
import type { OperatorInfo, VersionEntry, VersionStore } from '../../store/version-store.js'

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

/** The pause after which a document is considered settled. */
export const AUTO_VERSION_QUIET_MS = CHECKPOINT_QUIET_MS
/** How long editing may run with no pause before a checkpoint is taken regardless. */
export const AUTO_VERSION_CEILING_MS = CHECKPOINT_CEILING_MS

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

export type AutoVersionTrigger = CheckpointScheduler

/**
 * The "this document changed" signal, held where BOTH halves can import it
 * statically.
 *
 * `document.ts` registers it and `ws.ts` calls it, and those two cannot import
 * each other — the di wiring's chain closes a value cycle back through
 * canvas-client-notifier. document.ts bridged that with
 * `void import('./ws.js').then(...)`, a promise nobody awaited: measured, TWO
 * were still in flight when a router-building test file's last test ended, so
 * whether that module graph finished before vitest tore the environment down
 * was a coin flip. Losing it read as
 * `EnvironmentTeardownError: Cannot load .../timing-safe.ts` — an unhandled
 * rejection that exits the run 1 while every test reports passed, which is the
 * most misleading shape a red run has.
 *
 * A third module both halves can see costs nothing and leaves nothing in
 * flight. It also closes a real if narrow window: registration is now
 * synchronous, where before a WS message arriving between the router's
 * construction and the import's landing signalled the no-op below and took no
 * checkpoint at all.
 *
 * Looser than `AutoVersionTrigger` deliberately — a caller needs the call
 * signature and nothing else, and ws.ts's own tests register a bare function
 * carrying neither `flush` nor `stop`.
 */
export type AutoVersionSignal = (workspaceId: string, path: string, doc: LoroDoc) => void

let registeredSignal: AutoVersionSignal = () => {}

export function setAutoVersionTrigger(fn: AutoVersionSignal): void {
  registeredSignal = fn
}

/** The registered signal, or the no-op that stands in before one arrives. */
export function currentAutoVersionSignal(): AutoVersionSignal {
  return registeredSignal
}

export function createAutoVersionTrigger(
  versionStore: VersionStore,
  options: AutoVersionOptions = {},
): AutoVersionTrigger {
  return createCheckpointScheduler<VersionEntry>({
    ...(options.quietMs === undefined ? {} : { quietMs: options.quietMs }),
    ...(options.ceilingMs === undefined ? {} : { ceilingMs: options.ceilingMs }),
    ...(options.getHeadBranch === undefined ? {} : { getHeadBranch: options.getHeadBranch }),
    ...(options.onSaved === undefined ? {} : { onSaved: options.onSaved }),
    save: (workspaceId, path, doc, branchName) => {
      const opts: { auto: boolean; branchName?: string; operator: OperatorInfo } = {
        auto: true,
        operator: { kind: 'system', peerId: doc.peerIdStr, displayName: 'auto-save' },
      }
      if (typeof branchName === 'string' && branchName.length > 0) opts.branchName = branchName
      return versionStore.save(workspaceId, path, doc, opts)
    },
    // Corrupt stored data must not be absorbed into "no branch": the
    // checkpoint would be filed under `main` and the corruption hidden.
    isFatal: isCorruptStoredDataError,
    onError: (err, { workspaceId, path }) => {
      getLogger('auto-version').error({ workspaceId, path, err: err as Error }, 'save failed')
    },
  })
}
