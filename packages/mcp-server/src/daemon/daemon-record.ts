// The one reader of daemon.json. Every command that reads the record — status,
// doctor, stop, run, the native host, the replica-posture commands, the
// startup version-skew warning — takes its verdict from here, because two
// readers reached two verdicts over the same file: one called a record of a
// live daemon of another version malformed and advised removing it, while the
// other refused to start a second daemon beside it.

import { join } from 'node:path'
import {
  assertDataDirOwnedByUser,
  DATA_DIR,
  readFileOwnedByUser,
} from '../shared/data-dir-secure.js'
import { type DaemonLiveness, type DaemonLivenessSeams, daemonLiveness } from './daemon-liveness.js'
import {
  type DaemonRecord,
  type DaemonRecordBase,
  daemonRecordBaseSchema,
  daemonRecordSchema,
  type RecordedDaemon,
  recordedDaemonSchema,
} from './daemon-record-schema.js'

/**
 * Exported so `backupDataDir` can keep it OUT of a backup. The file holds the
 * Bearer token the daemon authenticates its HTTP routes and sync stream with — which is why it is
 * written 0o600 — and a backup directory is the opposite of owner-only.
 */
export const DAEMON_RECORD_FILENAME = 'daemon.json'

export function getDaemonRecordPath(dataDir: string = DATA_DIR): string {
  return join(dataDir, DAEMON_RECORD_FILENAME)
}

/** A daemon that may still be serving, so its record is nobody's to remove. */
export type OccupyingLiveness = Extract<DaemonLiveness, { state: 'running' | 'unconfirmed' }>

/**
 * - `missing`: no record.
 * - `malformed`: a record that names no daemon this build can ask about, or
 *   one it cannot interpret whose daemon is gone — a leftover either way.
 *   `unreadable` is set when the file exists but could not be read at all,
 *   which a caller about to start a daemon must not take for absence.
 * - `token-missing`: a record of this build's shape without a token; the
 *   daemon it names may still be serving, which `liveness` says.
 * - `uninterpretable`: a record this build cannot interpret whose daemon is
 *   still there — likeliest one of another version. Removing it would leave
 *   that daemon serving with no record, so it is reported, never discarded.
 * - `valid`: a record this build can use.
 */
export type DaemonRecordParseResult =
  | { kind: 'missing' }
  | { kind: 'malformed'; message: string; unreadable?: Error }
  | { kind: 'token-missing'; record: DaemonRecordBase; liveness: DaemonLiveness }
  | { kind: 'uninterpretable'; recorded: RecordedDaemon; liveness: OccupyingLiveness }
  | { kind: 'valid'; record: DaemonRecord }

export function isOccupying(liveness: DaemonLiveness): liveness is OccupyingLiveness {
  return liveness.state === 'running' || liveness.state === 'unconfirmed'
}

type ReadOutcome =
  | { kind: 'text'; text: string }
  | Exclude<DaemonRecordParseResult, { kind: 'valid' }>

async function readRecordText(dataDir: string): Promise<ReadOutcome> {
  try {
    assertDataDirOwnedByUser(dataDir)
  } catch (err) {
    return { kind: 'malformed', message: (err as Error).message, unreadable: err as Error }
  }
  const recordPath = getDaemonRecordPath(dataDir)
  let read: Awaited<ReturnType<typeof readFileOwnedByUser>>
  try {
    read = await readFileOwnedByUser(recordPath)
  } catch (err) {
    return {
      kind: 'malformed',
      message: 'Could not read daemon record file.',
      unreadable: new Error(`the daemon record ${recordPath} exists but cannot be read`, {
        cause: err,
      }),
    }
  }
  if (read.kind === 'missing') return { kind: 'missing' }
  if (read.kind === 'not-owned') {
    return { kind: 'malformed', message: read.message, unreadable: new Error(read.message) }
  }
  return { kind: 'text', text: read.text }
}

/**
 * Reads and classifies the record, asking `daemonLiveness` — through `seams`
 * — of any record it cannot use, since only that answer says whether the
 * record is a leftover or the only name a running daemon has.
 */
export async function parseDaemonRecord(
  dataDir: string,
  seams: DaemonLivenessSeams = {},
): Promise<DaemonRecordParseResult> {
  const read = await readRecordText(dataDir)
  if (read.kind !== 'text') return read

  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    return { kind: 'malformed', message: 'Daemon record is not valid JSON.' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed', message: 'Daemon record is not an object.' }
  }

  const fullResult = daemonRecordSchema.safeParse(parsed)
  if (fullResult.success) {
    return { kind: 'valid', record: fullResult.data }
  }

  // The full schema also fails for missing/empty token, so re-check against
  // the token-less base schema to distinguish "token missing" (a record we
  // can still report on) from one this build cannot interpret. The base
  // schema strips `token` entirely, so a present-but-wrong-typed token (e.g. a
  // number) would slip through as token-missing — guard that explicitly.
  const token = (parsed as Record<string, unknown>).token
  const tokenIsAbsentOrEmpty = token === undefined || token === ''
  const baseResult = daemonRecordBaseSchema.safeParse(parsed)
  if (baseResult.success && tokenIsAbsentOrEmpty) {
    const liveness = await daemonLiveness(baseResult.data, seams)
    return { kind: 'token-missing', record: baseResult.data, liveness }
  }

  const named = recordedDaemonSchema.safeParse(parsed)
  if (!named.success) {
    return { kind: 'malformed', message: 'Daemon record is missing required fields.' }
  }
  const liveness = await daemonLiveness(named.data, seams)
  if (isOccupying(liveness)) {
    return { kind: 'uninterpretable', recorded: named.data, liveness }
  }
  return {
    kind: 'malformed',
    message: 'Daemon record cannot be interpreted by this version, and its daemon is gone.',
  }
}
