import {
  leaseOps,
  legacyRecordOps,
  loadCrdtEngine,
  type RecordOps,
} from '@kamiazya/whiteboard-loro-adapter'
import {
  type IndexRecordKind,
  leaseIndexKind,
  loroIndexKind,
} from '@kamiazya/whiteboard-workspace-index'
import { describeEnvIssues } from '../../shared/env-setting.js'
import { parseRecordKind, type RecordKindName } from './storage-env.js'

/**
 * What the daemon holds a workspace record as, with everything that depends on
 * the answer in one place: how a record is loaded, saved and compared, the
 * operations a session runs over it, how many stay resident, and how long an
 * unused one is kept.
 *
 * The cache and the store hold records as `object` and never learn which kind
 * they have; the casts that erase the kind's own type are here and only here.
 */
export interface WorkspaceRecordKind {
  readonly name: RecordKindName
  readonly index: IndexRecordKind<object>
  readonly ops: RecordOps<object>
  /** How many records stay resident, the least recently used dropped first. */
  readonly maxEntries: number
  /** How long an unused record is kept before it is given back; `null` keeps it until the bound drops it. */
  readonly idleMs: number | null
}

/**
 * A `LoroDoc` is freed by collecting it, so the bound is the only limit:
 * `scripts/measure/workspace-record-kinds-memory.mjs` puts four held
 * 360-document workspaces at 46MB, which sixteen keep near 180MB.
 */
const LORO: WorkspaceRecordKind = {
  name: 'loro',
  index: loroIndexKind as unknown as IndexRecordKind<object>,
  ops: legacyRecordOps as unknown as RecordOps<object>,
  maxEntries: 16,
  idleMs: null,
}

/**
 * An engine lease holds its document in the engine's own memory, about four
 * times a `LoroDoc` for the same record (207MB against 46MB for four workspaces
 * of 360 documents, by the same script), so fewer stay resident and an unused one is given back after a while.
 * Releasing returns the memory to the engine for reuse rather than to the OS
 * (178MB stayed resident after four releases, and opening them again grew the
 * process by 29MB), so what the idle time bounds is growth, not the resident
 * size after a busy hour.
 */
export const LEASE_IDLE_MS = 5 * 60_000
const LEASE: WorkspaceRecordKind = {
  name: 'lease',
  index: leaseIndexKind(loadCrdtEngine) as unknown as IndexRecordKind<object>,
  ops: leaseOps as unknown as RecordOps<object>,
  maxEntries: 4,
  idleMs: LEASE_IDLE_MS,
}

const KINDS: Record<RecordKindName, WorkspaceRecordKind> = { loro: LORO, lease: LEASE }

/**
 * The kind the environment chooses. A setting that is present and cannot be
 * understood aborts startup (`collectStorageEnvIssues`), so a malformed one that
 * reaches here is a caller that skipped it, and says so rather than guessing.
 */
export function workspaceRecordKindFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceRecordKind {
  const parsed = parseRecordKind(env)
  if (!parsed.ok) {
    throw new Error(
      describeEnvIssues([{ variable: 'WHITEBOARD_RECORD_KIND', reason: parsed.reason }]),
    )
  }
  return KINDS[parsed.value]
}

export function workspaceRecordKindNamed(name: RecordKindName): WorkspaceRecordKind {
  return KINDS[name]
}
