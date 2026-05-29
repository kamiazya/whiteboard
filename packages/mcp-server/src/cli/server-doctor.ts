// `whiteboard server doctor --json` diagnostics for server-mode.
//
// Runs 9 checks against the current server-mode deployment config:
// config parse, auth plan, JWKS reachability, data directory
// writability, record presence/validity, record file permissions,
// PID liveness, runtime ping, and runtime status leak.
//
// Design mirrors daemon-doctor.ts: injectable seams for every I/O
// operation so the entire check sequence is testable without a real
// network or filesystem. Hardcoded, non-interpolated copy for
// summary/detail/remediation — no raw URLs, paths, tokens, or
// credentials ever appear in result fields.

import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import {
  type DaemonDoctorCheck,
  type DaemonDoctorOverallStatus,
  type DaemonDoctorResult,
  daemonDoctorResultSchema,
} from '../shared/api-contracts/daemon-doctor.js'
import { redactDiagnosticText } from '../shared/diagnostics/redact.js'
import { resolveDefaultDataDir } from '../daemon/data-dir.js'
import { parseServerModeEnvConfig } from '../server/security/server-mode-env-config.js'
import { planServerModeAuth } from '../server/security/server-mode-auth-plan.js'
import {
  getServerModeRecordPath,
  readServerModeRecord,
} from '../server/security/server-mode-record.js'
import type { ServerModeRecord } from '../server/security/server-mode-record.js'
import { ENV_KEYS } from '../server/security/server-mode-env-config.js'
import type { ServerRunArgs } from './server-run-args.js'

export const SERVER_DOCTOR_SCHEMA_VERSION = 1 as const

export type {
  DaemonDoctorCheck as ServerDoctorCheck,
  DaemonDoctorOverallStatus as ServerDoctorOverallStatus,
  DaemonDoctorResult as ServerDoctorResult,
} from '../shared/api-contracts/daemon-doctor.js'

export interface RunServerDoctorOptions {
  flags: ServerRunArgs & { kind: 'ok' }
  env?: NodeJS.ProcessEnv
  // Test seam: check if a PID is alive. Default: process.kill(pid, 0).
  isPidAlive?: (pid: number) => boolean
  // Test seam: verify the running process identity via /api/runtime/ping.
  verifyIdentity?: (record: ServerModeRecord) => Promise<boolean>
  // Test seam: fetch the JWKS URI and check it has keys.
  fetchJwks?: (uri: string) => Promise<{ ok: boolean; hasKeys: boolean }>
  // Test seam: check if the data directory is writable.
  checkDataDir?: (dataDir: string) => 'ok' | 'not-writable' | 'not-exists'
  // Test seam: read the POSIX mode bits of the record file.
  readRecordMode?: (dataDir: string) => number | null
  // Test seam: fetch /api/runtime/ping and compare the returned pid to expectedPid.
  fetchPing?: (host: string, port: number, expectedPid: number) => Promise<{ ok: boolean; pidMatches: boolean }>
  // Test seam: fetch /api/runtime/status and check for leaked fields.
  // `protected: true` means the endpoint returned 401/403 (correctly secured).
  fetchRuntimeStatus?: (
    host: string,
    port: number,
  ) => Promise<{ ok: boolean; protected: boolean; leakDetected: boolean }>
}

export interface RunServerDoctorOutcome {
  result: DaemonDoctorResult
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

// Mirrors the same helper in server-status.ts and server-stop.ts.
// Kept local per the project instruction: no new shared module for
// this small utility until there are three callers.
function resolveConnectHost(bindHost: string): string {
  if (bindHost === '0.0.0.0') return '127.0.0.1'
  if (bindHost === '::' || bindHost === '::0') return '[::1]'
  // Bare IPv6 addresses contain colons — bracket them for URL construction.
  if (bindHost.includes(':') && !bindHost.startsWith('[')) return `[${bindHost}]`
  return bindHost
}

async function defaultVerifyIdentity(record: ServerModeRecord): Promise<boolean> {
  const host = resolveConnectHost(record.host)
  try {
    const res = await fetch(`http://${host}:${record.port}/api/runtime/ping`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { pid?: unknown }
    return typeof body?.pid === 'number' && body.pid === record.pid
  } catch {
    return false
  }
}

async function defaultFetchJwks(uri: string): Promise<{ ok: boolean; hasKeys: boolean }> {
  try {
    const res = await fetch(uri, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return { ok: false, hasKeys: false }
    const body = await res.json()
    const hasKeys =
      Array.isArray((body as { keys?: unknown }).keys) &&
      (body as { keys: unknown[] }).keys.length > 0
    return { ok: true, hasKeys }
  } catch {
    return { ok: false, hasKeys: false }
  }
}

function defaultCheckDataDir(dataDir: string): 'ok' | 'not-writable' | 'not-exists' {
  try {
    const st = statSync(dataDir)
    if (!st.isDirectory()) return 'not-exists'
    accessSync(dataDir, fsConstants.W_OK)
    return 'ok'
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return 'not-exists'
    }
    return 'not-writable'
  }
}

function defaultReadRecordMode(dataDir: string): number | null {
  try {
    const path = getServerModeRecordPath(dataDir)
    const st = statSync(path)
    return st.mode & 0o777
  } catch {
    return null
  }
}

async function defaultFetchPing(
  host: string,
  port: number,
  expectedPid: number,
): Promise<{ ok: boolean; pidMatches: boolean }> {
  const connectHost = resolveConnectHost(host)
  try {
    const res = await fetch(`http://${connectHost}:${port}/api/runtime/ping`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return { ok: false, pidMatches: false }
    const body = (await res.json()) as { pid?: unknown }
    return { ok: true, pidMatches: typeof body?.pid === 'number' && body.pid === expectedPid }
  } catch {
    return { ok: false, pidMatches: false }
  }
}

// Leak patterns to check in the runtime/status response body text.
// None of these should appear in a well-configured server-mode response.
const LEAK_PATTERNS = [
  'jwksUri',
  'jwtIssuer',
  'Bearer',
  'Authorization',
  'eyJ', // JWT prefix
  'token',
]

async function defaultFetchRuntimeStatus(
  host: string,
  port: number,
): Promise<{ ok: boolean; protected: boolean; leakDetected: boolean }> {
  const connectHost = resolveConnectHost(host)
  try {
    const res = await fetch(`http://${connectHost}:${port}/api/runtime/status`, {
      signal: AbortSignal.timeout(2000),
    })
    // 401/403 means the endpoint is correctly protected by OAuth.
    if (res.status === 401 || res.status === 403) {
      return { ok: true, protected: true, leakDetected: false }
    }
    if (!res.ok) return { ok: false, protected: false, leakDetected: false }
    const text = await res.text()
    const leakDetected = LEAK_PATTERNS.some((p) => text.includes(p))
    return { ok: true, protected: false, leakDetected }
  } catch {
    return { ok: false, protected: false, leakDetected: false }
  }
}

// Merges CLI flags on top of a base env, same logic as server-run.ts.
// Not exported from that module, so duplicated here per project policy.
function mergeCliFlagsIntoEnv(
  base: NodeJS.ProcessEnv,
  flags: ServerRunArgs & { kind: 'ok' },
): NodeJS.ProcessEnv {
  const env = { ...base }
  if (flags.externalUrl !== undefined) env[ENV_KEYS.EXTERNAL_URL] = flags.externalUrl
  if (flags.allowedOrigins !== undefined) env[ENV_KEYS.ALLOWED_ORIGINS] = flags.allowedOrigins
  if (flags.authStrategy !== undefined) env[ENV_KEYS.AUTH_STRATEGY] = flags.authStrategy
  if (flags.jwtIssuer !== undefined) env[ENV_KEYS.JWT_ISSUER] = flags.jwtIssuer
  if (flags.jwtAudience !== undefined) env[ENV_KEYS.JWT_AUDIENCE] = flags.jwtAudience
  if (flags.jwksUri !== undefined) env[ENV_KEYS.JWKS_URI] = flags.jwksUri
  if (flags.jwtClockSkew !== undefined) env[ENV_KEYS.JWT_CLOCK_SKEW_SECONDS] = flags.jwtClockSkew
  if (flags.jwtScopeClaim !== undefined) env[ENV_KEYS.JWT_SCOPE_CLAIM] = flags.jwtScopeClaim
  if (flags.host !== undefined) env[ENV_KEYS.HOST] = flags.host
  if (flags.port !== undefined) env[ENV_KEYS.PORT] = flags.port
  if (flags.dataDir !== undefined) env[ENV_KEYS.DATA_DIR] = flags.dataDir
  if (flags.trustedProxy === true) env[ENV_KEYS.TRUSTED_PROXY] = 'true'
  if (flags.trustedProxy === false) env[ENV_KEYS.TRUSTED_PROXY] = 'false'
  return env
}

function redactDoctorCheck(check: DaemonDoctorCheck): DaemonDoctorCheck {
  return {
    ...check,
    summary: redactDiagnosticText(check.summary),
    ...(check.detail !== undefined ? { detail: redactDiagnosticText(check.detail) } : {}),
    ...(check.remediation !== undefined
      ? { remediation: redactDiagnosticText(check.remediation) }
      : {}),
  }
}

function aggregateOverallStatus(checks: DaemonDoctorCheck[]): {
  ok: boolean
  status: DaemonDoctorOverallStatus
} {
  let hasError = false
  let hasWarning = false
  for (const check of checks) {
    if (check.status === 'error') hasError = true
    else if (check.status === 'warning') hasWarning = true
  }
  if (hasError) return { ok: false, status: 'error' }
  if (hasWarning) return { ok: true, status: 'warning' }
  return { ok: true, status: 'ok' }
}

export async function runServerDoctor(
  options: RunServerDoctorOptions,
): Promise<RunServerDoctorOutcome> {
  const env = mergeCliFlagsIntoEnv(options.env ?? process.env, options.flags)
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive
  const verifyIdentity = options.verifyIdentity ?? defaultVerifyIdentity
  const fetchJwks = options.fetchJwks ?? defaultFetchJwks
  const checkDataDir = options.checkDataDir ?? defaultCheckDataDir
  const readRecordMode = options.readRecordMode ?? defaultReadRecordMode
  const fetchPing = options.fetchPing ?? defaultFetchPing
  const fetchRuntimeStatus = options.fetchRuntimeStatus ?? defaultFetchRuntimeStatus

  const checks: DaemonDoctorCheck[] = []

  // ── 1. server.config ─────────────────────────────────────────────
  const configResult = parseServerModeEnvConfig(env)
  if (!configResult.ok) {
    checks.push({
      id: 'server.config',
      status: 'error',
      summary: 'Server config is invalid',
      detail: `Config error: code=${configResult.code}`,
      remediation: 'Check your WHITEBOARD_SERVER_* environment variables.',
    })
    // Cannot proceed: all downstream checks depend on a valid config.
    for (const id of [
      'server.exposure',
      'server.jwks',
      'server.data_dir',
      'server.record',
      'server.record_permissions',
      'server.identity',
      'server.runtime_ping',
      'server.runtime_status',
    ]) {
      checks.push({
        id,
        status: 'skipped',
        summary: 'Skipped because the server config is invalid',
      })
    }
    const rawChecks = checks.map(redactDoctorCheck)
    const { ok, status } = aggregateOverallStatus(rawChecks)
    const result: DaemonDoctorResult = daemonDoctorResultSchema.parse({
      schemaVersion: SERVER_DOCTOR_SCHEMA_VERSION,
      ok,
      status,
      checks: rawChecks,
    })
    return { result, exitCode: ok ? 0 : 1 }
  }

  const config = configResult.config
  checks.push({ id: 'server.config', status: 'ok', summary: 'Server config is valid' })

  // ── 2. server.exposure ───────────────────────────────────────────
  const plan = planServerModeAuth({
    mode: 'server-mode',
    bindHost: config.host,
    externalUrl: config.externalUrl,
    allowedOrigins: [...config.allowedOrigins],
    trustedProxy: config.trustedProxy,
  })
  if (!plan.ok) {
    checks.push({
      id: 'server.exposure',
      status: 'error',
      summary: 'Server exposure plan is invalid',
      detail: `Exposure error: code=${plan.code}`,
      remediation:
        'Check WHITEBOARD_SERVER_EXTERNAL_URL and WHITEBOARD_SERVER_ALLOWED_ORIGINS. Wildcards and non-HTTPS origins are not allowed.',
    })
  } else {
    checks.push({ id: 'server.exposure', status: 'ok', summary: 'Server exposure plan is valid' })
  }

  // ── 3. server.jwks ───────────────────────────────────────────────
  const jwksResult = await fetchJwks(config.jwksUri)
  if (!jwksResult.ok) {
    checks.push({
      id: 'server.jwks',
      status: 'error',
      summary: 'JWKS endpoint is not reachable',
      remediation:
        'Ensure the JWKS URI is reachable from this server and returns a JSON document with a non-empty `keys` array.',
    })
  } else if (!jwksResult.hasKeys) {
    checks.push({
      id: 'server.jwks',
      status: 'error',
      summary: 'JWKS endpoint returned no keys',
      remediation: 'Check that the JWKS endpoint returns a JSON document with a non-empty `keys` array.',
    })
  } else {
    checks.push({ id: 'server.jwks', status: 'ok', summary: 'JWKS endpoint is reachable and has keys' })
  }

  // ── 4. server.data_dir ───────────────────────────────────────────
  const dataDir = config.dataDir ?? resolveDefaultDataDir(env)
  const dataDirState = checkDataDir(dataDir)
  if (dataDirState === 'not-exists') {
    checks.push({
      id: 'server.data_dir',
      status: 'error',
      summary: 'Data directory does not exist',
      remediation: 'Create the data directory or set WHITEBOARD_DATA_DIR to an existing writable path.',
    })
  } else if (dataDirState === 'not-writable') {
    checks.push({
      id: 'server.data_dir',
      status: 'error',
      summary: 'Data directory is not writable',
      remediation: 'Grant write access to the data directory for this process.',
    })
  } else {
    checks.push({ id: 'server.data_dir', status: 'ok', summary: 'Data directory is writable' })
  }

  // ── 5. server.record ─────────────────────────────────────────────
  const recordResult = readServerModeRecord(dataDir)
  let record: ServerModeRecord | null = null

  if (recordResult.kind === 'missing') {
    checks.push({
      id: 'server.record',
      status: 'skipped',
      summary: 'Server record not found — server may not be running',
    })
  } else if (recordResult.kind === 'malformed') {
    checks.push({
      id: 'server.record',
      status: 'warning',
      summary: 'Server record is malformed',
      remediation: 'Delete the stale server record or restart the server.',
    })
  } else {
    record = recordResult.record
    checks.push({ id: 'server.record', status: 'ok', summary: 'Server record found and valid' })
  }

  // ── 6. server.record_permissions ─────────────────────────────────
  const platform = process.platform
  if (recordResult.kind !== 'ok') {
    checks.push({
      id: 'server.record_permissions',
      status: 'skipped',
      summary: 'Skipped because the server record is missing or malformed',
    })
  } else if (platform === 'win32') {
    checks.push({
      id: 'server.record_permissions',
      status: 'skipped',
      summary: 'Skipped on Windows because POSIX mode bits do not apply',
    })
  } else {
    const mode = readRecordMode(dataDir)
    if (mode === null) {
      checks.push({
        id: 'server.record_permissions',
        status: 'skipped',
        summary: 'Skipped because the server record permissions could not be read',
      })
    } else if ((mode & 0o077) !== 0) {
      checks.push({
        id: 'server.record_permissions',
        status: 'warning',
        summary: 'Server record file has broad permissions',
        detail: 'Group or other has read, write, or execute access to the server record file.',
        remediation: 'Restrict the server record so only the current user can read and write it.',
      })
    } else {
      checks.push({
        id: 'server.record_permissions',
        status: 'ok',
        summary: 'Server record permissions are restricted',
      })
    }
  }

  // ── 7. server.identity ───────────────────────────────────────────
  if (record === null) {
    checks.push({
      id: 'server.identity',
      status: 'skipped',
      summary: 'Skipped because the server record is unavailable',
    })
  } else if (!isPidAlive(record.pid)) {
    checks.push({
      id: 'server.identity',
      status: 'skipped',
      summary: 'Skipped because the recorded server process is not running',
    })
  } else {
    const rightProcess = await verifyIdentity(record)
    if (!rightProcess) {
      checks.push({
        id: 'server.identity',
        status: 'warning',
        summary: 'Server process identity could not be confirmed',
        remediation: 'Restart the server to refresh the server record.',
      })
    } else {
      checks.push({ id: 'server.identity', status: 'ok', summary: 'Server process identity confirmed' })
    }
  }

  // ── 8. server.runtime_ping ───────────────────────────────────────
  const identityCheck = checks.find((c) => c.id === 'server.identity')
  const identityOk = identityCheck?.status === 'ok'

  if (!identityOk || record === null) {
    checks.push({
      id: 'server.runtime_ping',
      status: 'skipped',
      summary: 'Skipped because server identity is not confirmed',
    })
  } else {
    const pingResult = await fetchPing(record.host, record.port, record.pid)
    if (!pingResult.ok) {
      checks.push({
        id: 'server.runtime_ping',
        status: 'error',
        summary: 'Runtime ping endpoint did not respond',
        remediation: 'Check that the server is running and bound to the recorded host and port.',
      })
    } else if (!pingResult.pidMatches) {
      checks.push({
        id: 'server.runtime_ping',
        status: 'warning',
        summary: 'Runtime ping responded but PID does not match the server record',
        remediation: 'Restart the server to refresh the server record.',
      })
    } else {
      checks.push({ id: 'server.runtime_ping', status: 'ok', summary: 'Runtime ping responded successfully' })
    }
  }

  // ── 9. server.runtime_status ─────────────────────────────────────
  if (!identityOk || record === null) {
    checks.push({
      id: 'server.runtime_status',
      status: 'skipped',
      summary: 'Skipped because server identity is not confirmed',
    })
  } else {
    const statusResult = await fetchRuntimeStatus(record.host, record.port)
    if (!statusResult.ok) {
      checks.push({
        id: 'server.runtime_status',
        status: 'error',
        summary: 'Runtime status endpoint did not respond',
        remediation: 'Check that the server is running and accepting requests.',
      })
    } else if (statusResult.protected) {
      // 401/403: the endpoint is correctly protected by OAuth — this is
      // expected behavior for a server-mode deployment.
      checks.push({
        id: 'server.runtime_status',
        status: 'ok',
        summary: 'Runtime status endpoint is properly protected',
      })
    } else if (statusResult.leakDetected) {
      checks.push({
        id: 'server.runtime_status',
        status: 'warning',
        summary: 'Runtime status response may contain sensitive field names',
        remediation: 'Review the /api/runtime/status endpoint for information disclosure.',
      })
    } else {
      checks.push({
        id: 'server.runtime_status',
        status: 'ok',
        summary: 'Runtime status endpoint responded without detected leaks',
      })
    }
  }

  const redactedChecks = checks.map(redactDoctorCheck)
  const { ok, status } = aggregateOverallStatus(redactedChecks)
  const result: DaemonDoctorResult = daemonDoctorResultSchema.parse({
    schemaVersion: SERVER_DOCTOR_SCHEMA_VERSION,
    ok,
    status,
    checks: redactedChecks,
  })
  return { result, exitCode: ok ? 0 : 1 }
}
