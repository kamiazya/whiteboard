// Pure helper behind `whiteboard server status --json`.
//
// Reads the server-mode record, checks pid liveness, then verifies process
// identity via /api/runtime/ping (pid in response must match record). This
// two-factor check prevents PID-reuse races from misidentifying an unrelated
// process as the managed server.
//
// Non-leak contract: filesystem paths, JWKS URIs, tokens, and stack
// frames never appear in the result object or in stderr.

import { resolveDefaultDataDir } from '../daemon/data-dir.js'
import { readServerModeRecord } from '../server/security/server-mode-record.js'
import type { ServerModeRecord } from '../server/security/server-mode-record.js'
import { fetchDaemonPing } from './daemon-ping-client.js'

export const SERVER_STATUS_SCHEMA_VERSION = 1 as const

export type ServerStatusState = 'running' | 'missing' | 'stale' | 'malformed' | 'unverifiable'

export interface ServerStatusRunningResult {
  schemaVersion: typeof SERVER_STATUS_SCHEMA_VERSION
  ok: true
  state: 'running'
  pid: number
  host: string
  port: number
  publicBaseUrl: string
  authStrategy: 'oauth-jwt'
  startedAt: string
  recordFresh: true
}

export interface ServerStatusNotRunningResult {
  schemaVersion: typeof SERVER_STATUS_SCHEMA_VERSION
  ok: false
  state: Exclude<ServerStatusState, 'running'>
  recordFresh: false
}

export type ServerStatusResult = ServerStatusRunningResult | ServerStatusNotRunningResult

export interface RunServerStatusOptions {
  dataDir?: string
  isPidAlive?: (pid: number) => boolean
  /** Injection seam: confirm the running process is the managed server.
   *  Default: HTTP GET /api/runtime/ping, compare returned pid to record.pid. */
  verifyIdentity?: (record: ServerModeRecord) => Promise<boolean>
}

export interface RunServerStatusOutcome {
  result: ServerStatusResult
  exitCode: 0 | 1
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function defaultVerifyIdentity(record: ServerModeRecord): Promise<boolean> {
  // A record with no instanceId predates this check (older daemon build) and
  // cannot be verified — the caller reports 'unverifiable', never a silent
  // 'stale'/not-running or a false 'running'.
  if (!record.instanceId) return false
  const ping = await fetchDaemonPing(record.host, record.port)
  return ping !== null && ping.instanceId === record.instanceId
}

export async function runServerStatus(
  options: RunServerStatusOptions,
): Promise<RunServerStatusOutcome> {
  const dataDir = options.dataDir ?? resolveDefaultDataDir(process.env)
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive
  const verifyIdentity = options.verifyIdentity ?? defaultVerifyIdentity

  const readResult = readServerModeRecord(dataDir)

  if (readResult.kind === 'missing') {
    return {
      result: {
        schemaVersion: SERVER_STATUS_SCHEMA_VERSION,
        ok: false,
        state: 'missing',
        recordFresh: false,
      },
      exitCode: 1,
    }
  }

  if (readResult.kind === 'malformed') {
    return {
      result: {
        schemaVersion: SERVER_STATUS_SCHEMA_VERSION,
        ok: false,
        state: 'malformed',
        recordFresh: false,
      },
      exitCode: 1,
    }
  }

  const { record } = readResult
  if (!isPidAlive(record.pid)) {
    return {
      result: {
        schemaVersion: SERVER_STATUS_SCHEMA_VERSION,
        ok: false,
        state: 'stale',
        recordFresh: false,
      },
      exitCode: 1,
    }
  }

  const rightProcess = await verifyIdentity(record)
  if (!rightProcess) {
    return {
      result: {
        schemaVersion: SERVER_STATUS_SCHEMA_VERSION,
        ok: false,
        // A record without instanceId (legacy daemon build) can never be
        // confirmed — report 'unverifiable' rather than a false 'stale'.
        state: record.instanceId ? 'stale' : 'unverifiable',
        recordFresh: false,
      },
      exitCode: 1,
    }
  }

  // Allow-list construction: only the fields the caller needs.
  return {
    result: {
      schemaVersion: SERVER_STATUS_SCHEMA_VERSION,
      ok: true,
      state: 'running',
      pid: record.pid,
      host: record.host,
      port: record.port,
      publicBaseUrl: record.publicBaseUrl,
      authStrategy: record.authStrategy,
      startedAt: record.startedAt,
      recordFresh: true,
    },
    exitCode: 0,
  }
}
