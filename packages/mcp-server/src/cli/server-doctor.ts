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
import { resolveDefaultDataDir } from '../daemon/data-dir.js'
import { planServerModeAuth } from '../server/security/server-mode-auth-plan.js'
import { ENV_KEYS, parseServerModeEnvConfig } from '../server/security/server-mode-env-config.js'
import type { ServerModeRecord } from '../server/security/server-mode-record.js'
import {
  getServerModeRecordPath,
  readServerModeRecord,
} from '../server/security/server-mode-record.js'
import {
  type DaemonDoctorCheck,
  type DaemonDoctorOverallStatus,
  type DaemonDoctorResult,
  daemonDoctorResultSchema,
} from '../shared/api-contracts/daemon-doctor.js'
import { redactDiagnosticText } from '../shared/diagnostics/redact.js'
import { fetchDaemonPing, resolveConnectHost, verifyDaemonIdentity } from './daemon-ping-client.js'
import type { ServerRunArgs } from './server-run-args.js'

const SERVER_DOCTOR_SCHEMA_VERSION = 1 as const

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
  // Test seam: fetch /api/runtime/ping and compare the returned instanceId to
  // expectedInstanceId (undefined means the record predates instanceId and
  // can never match).
  fetchPing?: (
    host: string,
    port: number,
    expectedInstanceId: string | undefined,
  ) => Promise<{ ok: boolean; pidMatches: boolean }>
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

// Exported for direct unit testing of the instanceId comparison logic below
// (see server-doctor.test.ts) — the option default is otherwise only ever
// exercised indirectly through runServerDoctor with an injected override.
export const defaultVerifyIdentity = verifyDaemonIdentity

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

// Exported for direct unit testing — same rationale as defaultVerifyIdentity.
export async function defaultFetchPing(
  host: string,
  port: number,
  expectedInstanceId: string | undefined,
): Promise<{ ok: boolean; pidMatches: boolean }> {
  const ping = await fetchDaemonPing(host, port)
  if (ping === null) return { ok: false, pidMatches: false }
  return {
    ok: true,
    pidMatches: expectedInstanceId !== undefined && ping.instanceId === expectedInstanceId,
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

/**
 * Every check this doctor reports, in the order it runs them.
 *
 * ONE declaration, because there were two: the sequence below, and a list
 * of ids the invalid-config gate marked `skipped`. A check added to the
 * sequence and not to that list was simply ABSENT from the result on an
 * invalid config — no error, one fewer row, and the overall status
 * aggregated over whatever did report.
 */
export const SERVER_DOCTOR_CHECK_IDS = [
  'server.config',
  'server.exposure',
  'server.jwks',
  'server.data_dir',
  'server.record',
  'server.record_permissions',
  'server.identity',
  'server.runtime_ping',
  'server.runtime_status',
] as const

type ServerDoctorCheckId = (typeof SERVER_DOCTOR_CHECK_IDS)[number]

/** A check of THIS doctor: the shared contract's shape, with its own ids. */
type Check = DaemonDoctorCheck & { readonly id: ServerDoctorCheckId }

/** Everything but the config check, which is the one that gates them. */
function skippedBelowConfig(summary: string): Check[] {
  return SERVER_DOCTOR_CHECK_IDS.filter((id) => id !== 'server.config').map((id) => ({
    id,
    status: 'skipped' as const,
    summary,
  }))
}

// Each check answers for ITSELF: it takes what it needs and returns its
// verdict, rather than pushing into a shared array partway down a 290-line
// sequence. `runServerDoctor` below is then the ORDER and the data flow,
// which is the part a reader actually has to hold in their head.

/** Derived rather than imported: the parser does not export the shape. */
type ServerModeConfig = Extract<ReturnType<typeof parseServerModeEnvConfig>, { ok: true }>['config']

function checkExposure(config: ServerModeConfig): Check {
  const plan = planServerModeAuth({
    mode: 'server-mode',
    bindHost: config.host,
    externalUrl: config.externalUrl,
    allowedOrigins: [...config.allowedOrigins],
    trustedProxy: config.trustedProxy,
  })
  if (plan.ok) {
    return { id: 'server.exposure', status: 'ok', summary: 'Server exposure plan is valid' }
  }
  return {
    id: 'server.exposure',
    status: 'error',
    summary: 'Server exposure plan is invalid',
    detail: `Exposure error: code=${plan.code}`,
    remediation:
      'Check WHITEBOARD_SERVER_EXTERNAL_URL and WHITEBOARD_SERVER_ALLOWED_ORIGINS. Wildcards and non-HTTPS origins are not allowed.',
  }
}

function checkJwks(result: { ok: boolean; hasKeys: boolean }): Check {
  if (!result.ok) {
    return {
      id: 'server.jwks',
      status: 'error',
      summary: 'JWKS endpoint is not reachable',
      remediation:
        'Ensure the JWKS URI is reachable from this server and returns a JSON document with a non-empty `keys` array.',
    }
  }
  if (!result.hasKeys) {
    return {
      id: 'server.jwks',
      status: 'error',
      summary: 'JWKS endpoint returned no keys',
      remediation:
        'Check that the JWKS endpoint returns a JSON document with a non-empty `keys` array.',
    }
  }
  return {
    id: 'server.jwks',
    status: 'ok',
    summary: 'JWKS endpoint is reachable and has keys',
  }
}

function checkDataDirState(state: 'ok' | 'not-writable' | 'not-exists'): Check {
  if (state === 'not-exists') {
    return {
      id: 'server.data_dir',
      status: 'error',
      summary: 'Data directory does not exist',
      remediation:
        'Create the data directory or set WHITEBOARD_DATA_DIR to an existing writable path.',
    }
  }
  if (state === 'not-writable') {
    return {
      id: 'server.data_dir',
      status: 'error',
      summary: 'Data directory is not writable',
      remediation: 'Grant write access to the data directory for this process.',
    }
  }
  return { id: 'server.data_dir', status: 'ok', summary: 'Data directory is writable' }
}

function checkRecord(result: ReturnType<typeof readServerModeRecord>): Check {
  if (result.kind === 'missing') {
    return {
      id: 'server.record',
      status: 'skipped',
      summary: 'Server record not found — server may not be running',
    }
  }
  if (result.kind === 'malformed') {
    return {
      id: 'server.record',
      status: 'warning',
      summary: 'Server record is malformed',
      remediation: 'Delete the stale server record or restart the server.',
    }
  }
  return { id: 'server.record', status: 'ok', summary: 'Server record found and valid' }
}

function checkRecordPermissions(
  recordFound: boolean,
  platform: NodeJS.Platform,
  /** Read HERE, so the two guards above it still stand between the
   * platform and the filesystem: Windows never reads POSIX mode bits. */
  readMode: () => number | null,
): Check {
  if (!recordFound) {
    return {
      id: 'server.record_permissions',
      status: 'skipped',
      summary: 'Skipped because the server record is missing or malformed',
    }
  }
  if (platform === 'win32') {
    return {
      id: 'server.record_permissions',
      status: 'skipped',
      summary: 'Skipped on Windows because POSIX mode bits do not apply',
    }
  }
  const mode = readMode()
  if (mode === null) {
    return {
      id: 'server.record_permissions',
      status: 'skipped',
      summary: 'Skipped because the server record permissions could not be read',
    }
  }
  if ((mode & 0o077) !== 0) {
    return {
      id: 'server.record_permissions',
      status: 'warning',
      summary: 'Server record file has broad permissions',
      detail: 'Group or other has read, write, or execute access to the server record file.',
      remediation: 'Restrict the server record so only the current user can read and write it.',
    }
  }
  return {
    id: 'server.record_permissions',
    status: 'ok',
    summary: 'Server record permissions are restricted',
  }
}

async function checkIdentity(
  record: ServerModeRecord | null,
  isPidAlive: (pid: number) => boolean,
  verifyIdentity: (record: ServerModeRecord) => Promise<boolean>,
): Promise<Check> {
  if (record === null) {
    return {
      id: 'server.identity',
      status: 'skipped',
      summary: 'Skipped because the server record is unavailable',
    }
  }
  if (!isPidAlive(record.pid)) {
    return {
      id: 'server.identity',
      status: 'skipped',
      summary: 'Skipped because the recorded server process is not running',
    }
  }
  if (!(await verifyIdentity(record))) {
    return {
      id: 'server.identity',
      status: 'warning',
      summary: 'Server process identity could not be confirmed',
      remediation: 'Restart the server to refresh the server record.',
    }
  }
  return { id: 'server.identity', status: 'ok', summary: 'Server process identity confirmed' }
}

/**
 * Both runtime checks are gated on a CONFIRMED identity: talking to whatever
 * answers on the recorded port without it would be diagnosing a process this
 * doctor has no reason to believe is ours.
 */
const RUNTIME_UNCONFIRMED = 'Skipped because server identity is not confirmed'

async function checkRuntimePing(
  record: ServerModeRecord | null,
  identityOk: boolean,
  fetchPing: RequiredSeams['fetchPing'],
): Promise<Check> {
  if (!identityOk || record === null) {
    return { id: 'server.runtime_ping', status: 'skipped', summary: RUNTIME_UNCONFIRMED }
  }
  const result = await fetchPing(record.host, record.port, record.instanceId)
  if (!result.ok) {
    return {
      id: 'server.runtime_ping',
      status: 'error',
      summary: 'Runtime ping endpoint did not respond',
      remediation: 'Check that the server is running and bound to the recorded host and port.',
    }
  }
  if (!result.pidMatches) {
    return {
      id: 'server.runtime_ping',
      status: 'warning',
      summary: 'Runtime ping responded but PID does not match the server record',
      remediation: 'Restart the server to refresh the server record.',
    }
  }
  return { id: 'server.runtime_ping', status: 'ok', summary: 'Runtime ping responded successfully' }
}

async function checkRuntimeStatus(
  record: ServerModeRecord | null,
  identityOk: boolean,
  fetchRuntimeStatus: RequiredSeams['fetchRuntimeStatus'],
): Promise<Check> {
  if (!identityOk || record === null) {
    return { id: 'server.runtime_status', status: 'skipped', summary: RUNTIME_UNCONFIRMED }
  }
  const result = await fetchRuntimeStatus(record.host, record.port)
  if (!result.ok) {
    return {
      id: 'server.runtime_status',
      status: 'error',
      summary: 'Runtime status endpoint did not respond',
      remediation: 'Check that the server is running and accepting requests.',
    }
  }
  // 401/403: the endpoint is correctly protected by OAuth — this is
  // expected behavior for a server-mode deployment.
  if (result.protected) {
    return {
      id: 'server.runtime_status',
      status: 'ok',
      summary: 'Runtime status endpoint is properly protected',
    }
  }
  if (result.leakDetected) {
    return {
      id: 'server.runtime_status',
      status: 'warning',
      summary: 'Runtime status response may contain sensitive field names',
      remediation: 'Review the /api/runtime/status endpoint for information disclosure.',
    }
  }
  return {
    id: 'server.runtime_status',
    status: 'ok',
    summary: 'Runtime status endpoint responded without detected leaks',
  }
}

/** The seams with their defaults applied, as the checks above take them. */
type RequiredSeams = {
  [K in
    | 'isPidAlive'
    | 'verifyIdentity'
    | 'fetchJwks'
    | 'checkDataDir'
    | 'readRecordMode'
    | 'fetchPing'
    | 'fetchRuntimeStatus']-?: NonNullable<RunServerDoctorOptions[K]>
}

function finish(checks: Check[]): RunServerDoctorOutcome {
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

export async function runServerDoctor(
  options: RunServerDoctorOptions,
): Promise<RunServerDoctorOutcome> {
  const env = mergeCliFlagsIntoEnv(options.env ?? process.env, options.flags)
  const seams: RequiredSeams = {
    isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
    verifyIdentity: options.verifyIdentity ?? defaultVerifyIdentity,
    fetchJwks: options.fetchJwks ?? defaultFetchJwks,
    checkDataDir: options.checkDataDir ?? defaultCheckDataDir,
    readRecordMode: options.readRecordMode ?? defaultReadRecordMode,
    fetchPing: options.fetchPing ?? defaultFetchPing,
    fetchRuntimeStatus: options.fetchRuntimeStatus ?? defaultFetchRuntimeStatus,
  }

  const configResult = parseServerModeEnvConfig(env)
  if (!configResult.ok) {
    // Cannot proceed: every downstream check depends on a valid config.
    return finish([
      {
        id: 'server.config',
        status: 'error',
        summary: 'Server config is invalid',
        detail: `Config error: code=${configResult.code}`,
        remediation: 'Check your WHITEBOARD_SERVER_* environment variables.',
      },
      ...skippedBelowConfig('Skipped because the server config is invalid'),
    ])
  }
  const config = configResult.config

  const dataDir = config.dataDir ?? resolveDefaultDataDir(env)
  const recordResult = readServerModeRecord(dataDir)
  const record = recordResult.kind === 'ok' ? recordResult.record : null

  // In declared order, because each of these calls out: reordering them
  // would reorder the doctor's own network and filesystem reads.
  const checks: Check[] = [
    { id: 'server.config', status: 'ok', summary: 'Server config is valid' },
    checkExposure(config),
    checkJwks(await seams.fetchJwks(config.jwksUri)),
    checkDataDirState(seams.checkDataDir(dataDir)),
    checkRecord(recordResult),
    checkRecordPermissions(recordResult.kind === 'ok', process.platform, () =>
      seams.readRecordMode(dataDir),
    ),
  ]

  const identity = await checkIdentity(record, seams.isPidAlive, seams.verifyIdentity)
  // Read from the check itself rather than looking `server.identity` up in
  // the array being built, which is what the two runtime checks used to do.
  const identityOk = identity.status === 'ok'
  checks.push(
    identity,
    await checkRuntimePing(record, identityOk, seams.fetchPing),
    await checkRuntimeStatus(record, identityOk, seams.fetchRuntimeStatus),
  )

  return finish(checks)
}
