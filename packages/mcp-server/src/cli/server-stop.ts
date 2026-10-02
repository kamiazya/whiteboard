// Pure helper behind `whiteboard server stop --json`.
//
// Sends SIGTERM to the pid in the server-mode record only when the
// liveness gate passes. SIGTERM → wait → SIGKILL on timeout.
// A missing record, or one describing a process that is gone, is answered
// as not-running with exit 0: stopping what is already stopped is not an
// error here. `whiteboard daemon stop` is the opposite — it exits 1 for
// both a missing record and a dead process.
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
import { isErrnoCode } from '../shared/errno.js'
import { isPidAlive as defaultIsPidAlive } from '../shared/process-alive.js'
import { type TerminateOutcome, terminateAndWait } from '../shared/terminate-and-wait.js'
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

const defaultKillFn = (pid: number, signal: NodeJS.Signals | number) => {
  process.kill(pid, signal)
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

const defaultRemoveRecord = async (dataDir: string): Promise<void> => {
  await rm(getServerModeRecordPath(dataDir), { force: true })
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
 * What each way the stop can end means for the record and the operator.
 *
 * `ESRCH` on SIGTERM is not a failure at all — the process exited in the
 * window between the liveness check and the kill, which is the outcome this
 * command wanted. A SIGKILL withheld because the pid no longer identifies the
 * managed server answers the same as one that was sent, deliberately: our
 * server is gone either way, and the result has no field that could say
 * which.
 */
function stopOutcome(
  stopped: TerminateOutcome,
  record: ServerModeRecord,
): { outcome: RunServerStopOutcome; forget: boolean } {
  switch (stopped.kind) {
    case 'signal-failed':
      if (isErrnoCode(stopped.error, 'ESRCH')) {
        return { outcome: notRunning('server-process-not-running', record.pid), forget: true }
      }
      return {
        outcome: outcome(1, {
          action: 'refused',
          reason: 'server-stop-signal-failed',
          recordFound: true,
          recordFresh: true,
          pid: record.pid,
        }),
        forget: false,
      }
    case 'exited':
      return {
        outcome: outcome(0, {
          action: 'stopped',
          reason: null,
          recordFound: true,
          recordFresh: true,
          pid: record.pid,
        }),
        forget: true,
      }
    case 'killed':
    case 'kill-withheld':
      return {
        outcome: outcome(0, {
          action: 'stopped',
          reason: 'server-stop-timeout',
          recordFound: true,
          recordFresh: true,
          pid: record.pid,
        }),
        forget: true,
      }
  }
}

export async function runServerStop(options: RunServerStopOptions): Promise<RunServerStopOutcome> {
  const dataDir = options.dataDir ?? resolveDefaultDataDir(process.env)
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive
  const verifyIdentity = options.verifyIdentity ?? verifyDaemonIdentity
  const killFn = options.killFn ?? defaultKillFn
  const sleep = options.sleep ?? defaultSleep
  const removeRecord = options.removeRecord ?? defaultRemoveRecord
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  const refusal = await stopRefusal(dataDir, removeRecord, isPidAlive, verifyIdentity)
  if ('outcome' in refusal) return refusal.outcome
  const { record } = refusal

  // Before SIGKILL, re-identify: if the managed server has already exited and
  // its PID was reused, the polling loop saw the NEW process as still alive,
  // and SIGKILL would land on something unrelated.
  const stopped = await terminateAndWait({
    pid: record.pid,
    isAlive: isPidAlive,
    kill: killFn,
    sleep,
    timeoutMs: stopTimeoutMs,
    pollMs: pollIntervalMs,
    killWaitMs: 0,
    confirmKill: () => verifyIdentity(record),
  })
  const { outcome: answer, forget } = stopOutcome(stopped, record)
  if (forget) await forgetRecord(removeRecord, dataDir)
  return answer
}
