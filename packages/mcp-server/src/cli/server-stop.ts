// Pure helper behind `whiteboard server stop --json`.
//
// Sends SIGTERM to the pid in the server-mode record only when the
// liveness gate passes. SIGTERM → wait → SIGKILL on timeout.
// Stale / missing records are returned as not-running (exit 0) rather
// than errors, matching the "desired-state idempotent" contract of
// whiteboard daemon stop.
//
// Non-leak contract: paths, tokens, JWKS URIs and stack frames never
// appear in the result or stderr. The pid field IS included because
// operators need it to correlate with OS-level tools.

import { rm } from 'node:fs/promises'
import { resolveDefaultDataDir } from '../daemon/data-dir.js'
import type {
  ServerModeRecord,
  ServerModeRecordReadResult,
} from '../server/security/server-mode-record.js'
import {
  getServerModeRecordPath,
  readServerModeRecord,
} from '../server/security/server-mode-record.js'
import {
  type ServerStopResult,
  serverStopResultSchema,
} from '../shared/api-contracts/server-stop.js'
import { verifyDaemonIdentity } from './daemon-ping-client.js'

export const SERVER_STOP_SCHEMA_VERSION = 1 as const

export interface RunServerStopOptions {
  dataDir?: string
  isPidAlive?: (pid: number) => boolean
  /** Injection seam: confirm the running process is the managed server.
   *  Default: HTTP GET /api/runtime/ping, compare returned pid to record.pid. */
  verifyIdentity?: (record: ServerModeRecord) => Promise<boolean>
  killFn?: (pid: number, signal: NodeJS.Signals | number) => void
  sleep?: (ms: number) => Promise<void>
  removeRecord?: (dataDir: string) => Promise<void>
  stopTimeoutMs?: number
  pollIntervalMs?: number
}

export interface RunServerStopOutcome {
  result: ServerStopResult
  /** 0 stopped or already stopped, 1 the signal failed, 2 the record is unusable. */
  exitCode: 0 | 1 | 2
}

/**
 * One outcome, built from the exit code and what to say about it.
 *
 * `ok` is DERIVED (`exitCode === 0`) rather than written beside it: the two
 * were spelled out together at all nine returns, one of them a typo away
 * from disagreeing, in a pair a calling script branches on. The exit code
 * is the parameter because it carries a distinction `ok` cannot — a refused
 * stop is 1 when the signal failed and 2 when the record was unusable.
 */
function outcome(
  exitCode: RunServerStopOutcome['exitCode'],
  result: Omit<ServerStopResult, 'schemaVersion' | 'ok'>,
): RunServerStopOutcome {
  return {
    result: serverStopResultSchema.parse({
      schemaVersion: SERVER_STOP_SCHEMA_VERSION,
      ok: exitCode === 0,
      ...result,
    }),
    exitCode,
  }
}

/**
 * Drop the record, best-effort: it describes a process that is already
 * gone, so failing to delete it must not turn a successful stop into an
 * error. Its own try/catch stood at five call sites.
 */
async function forgetRecord(
  removeRecord: (dataDir: string) => Promise<void>,
  dataDir: string,
): Promise<void> {
  try {
    await removeRecord(dataDir)
  } catch {
    /* best-effort */
  }
}

// 10s matches the dispatcher's SIGTERM window. Overridable in tests.
const DEFAULT_STOP_TIMEOUT_MS = 10_000
const DEFAULT_POLL_INTERVAL_MS = 50

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Exported for direct unit testing of the live-ping comparison (see
// server-stop.test.ts) — the option default is otherwise only ever
// exercised indirectly through runServerStop with an injected override.
export const defaultVerifyIdentity = verifyDaemonIdentity

const defaultKillFn = (pid: number, signal: NodeJS.Signals | number) => {
  process.kill(pid, signal)
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const defaultRemoveRecord = async (dataDir: string): Promise<void> => {
  await rm(getServerModeRecordPath(dataDir), { force: true })
}

async function waitForExit(
  pid: number,
  isPidAlive: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(pollIntervalMs, remaining))
  }
  return !isPidAlive(pid)
}

/** The answer for a record that no longer describes a process we manage. */
function notRunning(reason: ServerStopResult['reason'], pid?: number): RunServerStopOutcome {
  return outcome(0, {
    action: 'not-running',
    reason,
    recordFound: true,
    recordFresh: false,
    ...(pid === undefined ? {} : { pid }),
  })
}

/**
 * The answer for each record this command cannot act on. Only a malformed
 * one is forgotten: a missing record has nothing to remove, and an
 * unreadable one may describe a live server — nothing is known about it, so
 * it is refused and left for its owner.
 */
const UNUSABLE_RECORD = {
  missing: {
    exitCode: 0,
    action: 'not-running',
    reason: 'server-record-not-found',
    recordFound: false,
    forget: false,
  },
  unreadable: {
    exitCode: 2,
    action: 'refused',
    reason: 'server-record-unreadable',
    recordFound: true,
    forget: false,
  },
  malformed: {
    exitCode: 2,
    action: 'refused',
    reason: 'server-record-malformed',
    recordFound: true,
    forget: true,
  },
} as const satisfies Record<
  Exclude<ServerModeRecordReadResult['kind'], 'ok'>,
  Pick<ServerStopResult, 'action' | 'reason' | 'recordFound'> & {
    exitCode: RunServerStopOutcome['exitCode']
    forget: boolean
  }
>

/**
 * Every reason NOT to signal anything, asked before a signal is sent. Each
 * one also forgets the record it just judged, because in every case the
 * record no longer describes a process this CLI manages.
 *
 * The two identity checks are the point: a PID-reuse race could have put an
 * unrelated process at `record.pid`, and killing it would be the worst thing
 * this command could do.
 */
async function stopRefusal(
  dataDir: string,
  removeRecord: NonNullable<RunServerStopOptions['removeRecord']>,
  isPidAlive: NonNullable<RunServerStopOptions['isPidAlive']>,
  verifyIdentity: NonNullable<RunServerStopOptions['verifyIdentity']>,
): Promise<{ record: ServerModeRecord } | { outcome: RunServerStopOutcome }> {
  const readResult = readServerModeRecord(dataDir)

  if (readResult.kind !== 'ok') {
    const { exitCode, forget, ...result } = UNUSABLE_RECORD[readResult.kind]
    if (forget) await forgetRecord(removeRecord, dataDir)
    return { outcome: outcome(exitCode, { ...result, recordFresh: false }) }
  }

  const { record } = readResult
  if (!isPidAlive(record.pid)) {
    await forgetRecord(removeRecord, dataDir)
    return { outcome: notRunning('server-process-not-running', record.pid) }
  }

  if (!(await verifyIdentity(record))) {
    await forgetRecord(removeRecord, dataDir)
    const reason = record.instanceId ? 'server-process-not-running' : 'server-instance-unverifiable'
    return { outcome: notRunning(reason, record.pid) }
  }

  return { record }
}

/**
 * SIGTERM, and the two ways it can fail. `ESRCH` is not a failure at all —
 * the process exited in the window between the liveness check and the kill,
 * which is the outcome this command wanted. `null` means the signal landed.
 */
async function sendStopSignal(
  record: ServerModeRecord,
  killFn: NonNullable<RunServerStopOptions['killFn']>,
  removeRecord: NonNullable<RunServerStopOptions['removeRecord']>,
  dataDir: string,
): Promise<RunServerStopOutcome | null> {
  try {
    killFn(record.pid, 'SIGTERM')
    return null
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH') {
      return outcome(1, {
        action: 'refused',
        reason: 'server-stop-signal-failed',
        recordFound: true,
        recordFresh: true,
        pid: record.pid,
      })
    }
  }
  await forgetRecord(removeRecord, dataDir)
  return notRunning('server-process-not-running', record.pid)
}

/**
 * SIGTERM timed out. Re-check identity before escalating: if the managed
 * server has already exited and its PID was reused, the polling loop would
 * have seen the NEW process as still alive, and SIGKILL would land on
 * something unrelated.
 *
 * Both paths answer the same outcome, deliberately: our server is gone
 * either way, and the result has no field that could say which.
 */
async function escalateAfterTimeout(
  record: ServerModeRecord,
  verifyIdentity: NonNullable<RunServerStopOptions['verifyIdentity']>,
  killFn: NonNullable<RunServerStopOptions['killFn']>,
  removeRecord: NonNullable<RunServerStopOptions['removeRecord']>,
  dataDir: string,
): Promise<RunServerStopOutcome> {
  if (await verifyIdentity(record)) {
    try {
      killFn(record.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  await forgetRecord(removeRecord, dataDir)
  return outcome(0, {
    action: 'stopped',
    reason: 'server-stop-timeout',
    recordFound: true,
    recordFresh: true,
    pid: record.pid,
  })
}

export async function runServerStop(options: RunServerStopOptions): Promise<RunServerStopOutcome> {
  const dataDir = options.dataDir ?? resolveDefaultDataDir(process.env)
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive
  const verifyIdentity = options.verifyIdentity ?? defaultVerifyIdentity
  const killFn = options.killFn ?? defaultKillFn
  const sleep = options.sleep ?? defaultSleep
  const removeRecord = options.removeRecord ?? defaultRemoveRecord
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  const refusal = await stopRefusal(dataDir, removeRecord, isPidAlive, verifyIdentity)
  if ('outcome' in refusal) return refusal.outcome
  const { record } = refusal

  const signalFailure = await sendStopSignal(record, killFn, removeRecord, dataDir)
  if (signalFailure !== null) return signalFailure

  const exited = await waitForExit(record.pid, isPidAlive, sleep, stopTimeoutMs, pollIntervalMs)
  if (!exited) {
    return await escalateAfterTimeout(record, verifyIdentity, killFn, removeRecord, dataDir)
  }

  await forgetRecord(removeRecord, dataDir)
  return outcome(0, {
    action: 'stopped',
    reason: null,
    recordFound: true,
    recordFresh: true,
    pid: record.pid,
  })
}
