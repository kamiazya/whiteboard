import {
  deleteDaemonRecord,
  isPidAlive as defaultIsPidAlive,
  loadDaemonRecord,
} from '../daemon/daemon-registry.js'

export interface DaemonStopResult {
  schemaVersion: 1
  ok: boolean
  action: 'stopped' | 'not-running' | 'refused'
  reason: string | null
  pid: number | null
}

export interface DaemonStopOptions {
  dataDir: string
  isPidAlive?: (pid: number) => boolean
  killFn?: (pid: number, signal: string) => void
  sleep?: (ms: number) => Promise<void>
  stopTimeoutMs?: number
  removeRecord?: (dataDir: string) => Promise<void>
}

function defaultKill(pid: number, signal: string): void {
  process.kill(pid, signal as NodeJS.Signals)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runDaemonStop(
  options: DaemonStopOptions,
): Promise<{ result: DaemonStopResult; exitCode: 0 | 1 }> {
  const isAlive = options.isPidAlive ?? defaultIsPidAlive
  const killFn = options.killFn ?? defaultKill
  const sleep = options.sleep ?? defaultSleep
  const stopTimeoutMs = options.stopTimeoutMs ?? 5000
  const removeRecord = options.removeRecord ?? deleteDaemonRecord

  const record = await loadDaemonRecord(options.dataDir)

  if (record === null) {
    return {
      result: {
        schemaVersion: 1,
        ok: false,
        action: 'not-running',
        reason: 'record-not-found',
        pid: null,
      },
      exitCode: 1,
    }
  }

  const { pid } = record

  if (!isAlive(pid)) {
    await removeRecord(options.dataDir)
    return {
      result: {
        schemaVersion: 1,
        ok: false,
        action: 'not-running',
        reason: 'process-not-running',
        pid,
      },
      exitCode: 1,
    }
  }

  try {
    killFn(pid, 'SIGTERM')
  } catch {
    return {
      result: {
        schemaVersion: 1,
        ok: false,
        action: 'refused',
        reason: 'kill-failed',
        pid,
      },
      exitCode: 1,
    }
  }

  const deadline = Date.now() + stopTimeoutMs
  const pollInterval = 100
  while (Date.now() < deadline) {
    await sleep(pollInterval)
    if (!isAlive(pid)) break
  }

  if (isAlive(pid)) {
    try {
      killFn(pid, 'SIGKILL')
    } catch {
      // Process may have died between the check and kill
    }
    await sleep(200)
  }

  await removeRecord(options.dataDir)

  return {
    result: {
      schemaVersion: 1,
      ok: true,
      action: 'stopped',
      reason: null,
      pid,
    },
    exitCode: 0,
  }
}
