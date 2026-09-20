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
import type { ServerModeRecord } from '../server/security/server-mode-record.js'
import {
  getServerModeRecordPath,
  readServerModeRecord,
} from '../server/security/server-mode-record.js'
import { verifyDaemonIdentity } from './daemon-ping-client.js'

export const SERVER_STOP_SCHEMA_VERSION = 1 as const

type ServerStopAction = 'stopped' | 'not-running' | 'refused'

type ServerStopReason =
  | null
  | 'server-record-not-found'
  | 'server-record-malformed'
  | 'server-process-not-running'
  | 'server-stop-signal-failed'
  | 'server-stop-timeout'
  // Record predates instanceId (written by an older daemon build). Identity
  // cannot be confirmed, so the safe choice is to refuse to kill rather than
  // risk terminating an unrelated process that reused the recorded pid.
  | 'server-instance-unverifiable'

interface ServerStopResult {
  schemaVersion: typeof SERVER_STOP_SCHEMA_VERSION
  ok: boolean
  action: ServerStopAction
  reason: ServerStopReason
  recordFound: boolean
  recordFresh: boolean
  pid?: number
}

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
    result: { schemaVersion: SERVER_STOP_SCHEMA_VERSION, ok: exitCode === 0, ...result },
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

export async function runServerStop(options: RunServerStopOptions): Promise<RunServerStopOutcome> {
  const dataDir = options.dataDir ?? resolveDefaultDataDir(process.env)
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive
  const verifyIdentity = options.verifyIdentity ?? defaultVerifyIdentity
  const killFn = options.killFn ?? defaultKillFn
  const sleep = options.sleep ?? defaultSleep
  const removeRecord = options.removeRecord ?? defaultRemoveRecord
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS

  const readResult = readServerModeRecord(dataDir)

  if (readResult.kind === 'missing') {
    return outcome(0, {
      action: 'not-running',
      reason: 'server-record-not-found',
      recordFound: false,
      recordFresh: false,
    })
  }

  if (readResult.kind === 'malformed') {
    // Refuse to kill an unknown process. Clean up the corrupt file.
    await forgetRecord(removeRecord, dataDir)
    return outcome(2, {
      action: 'refused',
      reason: 'server-record-malformed',
      recordFound: true,
      recordFresh: false,
    })
  }

  const { record } = readResult
  const alive = isPidAlive(record.pid)

  if (!alive) {
    await forgetRecord(removeRecord, dataDir)
    return outcome(0, {
      action: 'not-running',
      reason: 'server-process-not-running',
      recordFound: true,
      recordFresh: false,
      pid: record.pid,
    })
  }

  // PID is alive — verify it is actually our managed server before killing.
  // A PID-reuse race could have placed an unrelated process at record.pid.
  const rightProcess = await verifyIdentity(record)
  if (!rightProcess) {
    await forgetRecord(removeRecord, dataDir)
    return outcome(0, {
      action: 'not-running',
      reason: record.instanceId ? 'server-process-not-running' : 'server-instance-unverifiable',
      recordFound: true,
      recordFresh: false,
      pid: record.pid,
    })
  }

  try {
    killFn(record.pid, 'SIGTERM')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ESRCH') {
      // Process exited in the window between liveness check and kill.
      await forgetRecord(removeRecord, dataDir)
      return outcome(0, {
        action: 'not-running',
        reason: 'server-process-not-running',
        recordFound: true,
        recordFresh: false,
        pid: record.pid,
      })
    }
    return outcome(1, {
      action: 'refused',
      reason: 'server-stop-signal-failed',
      recordFound: true,
      recordFresh: true,
      pid: record.pid,
    })
  }

  const exited = await waitForExit(record.pid, isPidAlive, sleep, stopTimeoutMs, pollIntervalMs)

  if (!exited) {
    // SIGTERM timed out. Re-check identity before escalating to SIGKILL: if the
    // managed server has already exited and its PID was reused by another process,
    // the polling loop would have seen the new process as still alive. Do not kill
    // an unrelated process.
    const stillOurs = await verifyIdentity(record)
    if (!stillOurs) {
      await forgetRecord(removeRecord, dataDir)
      // Same outcome as the SIGKILL path below, deliberately: our server is
      // gone either way, and the result has no field that could say which.
      return outcome(0, {
        action: 'stopped',
        reason: 'server-stop-timeout',
        recordFound: true,
        recordFresh: true,
        pid: record.pid,
      })
    }
    try {
      killFn(record.pid, 'SIGKILL')
    } catch {
      /* already gone */
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

  await forgetRecord(removeRecord, dataDir)
  return outcome(0, {
    action: 'stopped',
    reason: null,
    recordFound: true,
    recordFresh: true,
    pid: record.pid,
  })
}
