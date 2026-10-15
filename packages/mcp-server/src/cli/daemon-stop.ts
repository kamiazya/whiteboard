import { type DaemonLiveness, daemonLiveness } from '../daemon/daemon-liveness.js'
import { deleteDaemonRecord, loadDaemonRecord } from '../daemon/daemon-registry.js'
import {
  type DaemonStopResult,
  daemonStopResultSchema,
} from '../shared/api-contracts/daemon-stop.js'
import { isPidAlive as defaultIsPidAlive } from '../shared/process-alive.js'
import { STOP_SIGTERM_WINDOW_MS } from '../shared/stop-timeouts.js'
import { terminateAndWait } from '../shared/terminate-and-wait.js'

export interface DaemonStopOptions {
  dataDir: string
  isPidAlive?: (pid: number) => boolean
  /** When a pid's process started; null where the platform cannot say. */
  processStartMs?: (pid: number) => number | null
  killFn?: (pid: number, signal: string) => void
  sleep?: (ms: number) => Promise<void>
  stopTimeoutMs?: number
  killWaitMs?: number
  removeRecord?: (dataDir: string) => Promise<void>
}

// SIGTERM's window and the poll inside it. The window is the file sweeper's
// stop cap plus the margin the rest of the close needs (`stop-timeouts.ts`),
// not a number of its own: a window equal to the cap SIGKILLs a daemon that
// is still stopping cleanly.
const DEFAULT_STOP_TIMEOUT_MS = STOP_SIGTERM_WINDOW_MS
const POLL_INTERVAL_MS = 100
// After SIGKILL the process only has to be reaped; polling ends the wait the
// moment it is gone.
const DEFAULT_KILL_WAIT_MS = 200

function defaultKill(pid: number, signal: string): void {
  process.kill(pid, signal as NodeJS.Signals)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const NOT_STOPPED = {
  unconfirmed: { action: 'refused', reason: 'identity-unconfirmed' },
  'pid-reused': { action: 'not-running', reason: 'pid-reused' },
  dead: { action: 'not-running', reason: 'process-not-running' },
} as const

function notStopped(
  liveness: Exclude<DaemonLiveness, { state: 'running' }>,
  pid: number,
): DaemonStopResult {
  return daemonStopResultSchema.parse({
    schemaVersion: 1,
    ok: false,
    ...NOT_STOPPED[liveness.state],
    pid,
    ...(liveness.state === 'unconfirmed' && liveness.servingPid !== undefined
      ? { servingPid: liveness.servingPid }
      : {}),
  })
}

export async function runDaemonStop(
  options: DaemonStopOptions,
): Promise<{ result: DaemonStopResult; exitCode: 0 | 1 }> {
  const isAlive = options.isPidAlive ?? defaultIsPidAlive
  const killFn = options.killFn ?? defaultKill
  const sleep = options.sleep ?? defaultSleep
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  const killWaitMs = options.killWaitMs ?? DEFAULT_KILL_WAIT_MS
  const removeRecord = options.removeRecord ?? deleteDaemonRecord

  const seams = { isAlive: options.isPidAlive, startMs: options.processStartMs }
  const record = await loadDaemonRecord(options.dataDir, seams)

  if (record === null) {
    return {
      result: daemonStopResultSchema.parse({
        schemaVersion: 1,
        ok: false,
        action: 'not-running',
        reason: 'record-not-found',
        pid: null,
      }),
      exitCode: 1,
    }
  }

  const { pid } = record
  // A record that outlived its daemon can name a pid another process has
  // since taken; that process is not the daemon and must not be signalled.
  const judge = () => daemonLiveness(record, seams)
  const liveness = await judge()
  if (liveness.state !== 'running') {
    // An unconfirmed daemon answers on the record's socket but not as this
    // pid: something is serving, so the record is not a leftover to drop, and
    // the pid is not known to be what is serving, so it is not signalled.
    if (liveness.state !== 'unconfirmed') await removeRecord(options.dataDir)
    return { result: notStopped(liveness, pid), exitCode: 1 }
  }

  const stopped = await terminateAndWait({
    pid,
    isAlive,
    kill: killFn,
    sleep,
    timeoutMs: stopTimeoutMs,
    pollMs: POLL_INTERVAL_MS,
    killWaitMs,
    confirmKill: async () => (await judge()).state === 'running',
  })
  if (stopped.kind === 'signal-failed') {
    return {
      result: daemonStopResultSchema.parse({
        schemaVersion: 1,
        ok: false,
        action: 'refused',
        reason: 'kill-failed',
        pid,
      }),
      exitCode: 1,
    }
  }

  await removeRecord(options.dataDir)

  return {
    result: daemonStopResultSchema.parse({
      schemaVersion: 1,
      ok: true,
      action: 'stopped',
      reason: null,
      pid,
    }),
    exitCode: 0,
  }
}
