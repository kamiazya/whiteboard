// `whiteboard server support-bundle --json` helper.
//
// Collects a redacted diagnostic bundle for server-mode operators and hands
// it to the writer both support-bundle commands share.
// Sections: status.json, doctor.json, record.json, manifest.json.
//
// Output contract (same as daemon-support-bundle.ts):
//   stdout: one JSON object + '\n' on success; '' on failure
//   stderr: '' on success; generic safe copy on failure
//   exitCode: 0 | 1
//
// Non-leak invariants:
//   - raw dataDir / outputDir / fs errors never reach stdout/stderr
//   - publicBaseUrl is stripped to host-only in record.json
//   - doctor checks are re-allow-listed and run through buildDoctorSection()
//     (redactDiagnosticText + auth-marker scrub on every stringy field)
//   - Authorization / Bearer / JWKS URI never appear in any section

import { z } from 'zod'
import type { ServerModeRecordReadResult } from '../server/security/server-mode-record.js'
import { readServerModeRecord } from '../server/security/server-mode-record.js'
import {
  buildDoctorSection,
  SUPPORT_BUNDLE_SCHEMA_VERSION,
  type SupportBundle,
  supportBundleDoctorSectionSchema,
} from '../shared/diagnostics/support-bundle.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import {
  OPERATOR_JSON_SCHEMA_VERSION,
  operatorJsonLine,
  serverSupportBundleOutputSchema,
} from './operator-json.js'
import type { RunServerDoctorOutcome } from './server-doctor.js'
import type { RunServerStatusOutcome } from './server-status.js'
import { writeSupportBundle } from './support-bundle-writer.js'

export interface ServerSupportBundleOptions {
  /** Resolved absolute path to server-mode data directory. */
  dataDir: string
  /** Resolved absolute path for the output bundle directory. */
  outputDir: string
  env?: NodeJS.ProcessEnv
  /** Test seam: pin createdAt for deterministic bundles. */
  now?: () => string
  /** Test seam: substitute package version; defaults to the one this package ships. */
  packageVersion?: string
  /** Test seam: substitute platform summary. */
  platform?: { os: string; nodeVersion: string }
  /** Test seam: replace runServerStatus call. */
  doRunStatus?: (dataDir: string) => Promise<RunServerStatusOutcome>
  /** Test seam: replace runServerDoctor call. */
  doRunDoctor?: (opts: {
    dataDir: string
    env: NodeJS.ProcessEnv
  }) => Promise<RunServerDoctorOutcome>
  /** Test seam: replace readServerModeRecord call. */
  doReadRecord?: (dataDir: string) => ServerModeRecordReadResult
}

export interface ServerSupportBundleOutcome {
  stdout: string
  stderr: string
  exitCode: 0 | 1
}

function succeeded(files: readonly string[]): ServerSupportBundleOutcome {
  const stdout = operatorJsonLine(serverSupportBundleOutputSchema, {
    schemaVersion: OPERATOR_JSON_SCHEMA_VERSION,
    ok: true,
    operation: 'support-bundle',
    files: [...files],
  })
  return { stdout, stderr: '', exitCode: 0 }
}

function fail(message: string): ServerSupportBundleOutcome {
  return { stdout: '', stderr: `${message}\n`, exitCode: 1 }
}

async function defaultRunStatus(dataDir: string): Promise<RunServerStatusOutcome> {
  const { runServerStatus } = await import('./server-status.js')
  return runServerStatus({ dataDir })
}

async function defaultRunDoctor(opts: {
  dataDir: string
  env: NodeJS.ProcessEnv
}): Promise<RunServerDoctorOutcome> {
  const { runServerDoctor } = await import('./server-doctor.js')
  // Drive the doctor entirely from the environment; no CLI flag overrides.
  // Set WHITEBOARD_DATA_DIR so the config parser and data-dir check pick
  // up the same path the bundle is collecting from.
  const effectiveEnv: NodeJS.ProcessEnv = { ...opts.env, WHITEBOARD_DATA_DIR: opts.dataDir }
  // Minimal flags: all optional server-run fields left undefined so only
  // env drives config — this captures the actual deployment state.
  const flags = {
    kind: 'ok' as const,
    json: true as const,
    dryRun: false,
    externalUrl: undefined,
    allowedOrigins: undefined,
    authStrategy: undefined,
    jwtIssuer: undefined,
    jwtAudience: undefined,
    jwksUri: undefined,
    jwtClockSkew: undefined,
    jwtScopeClaim: undefined,
    host: undefined,
    port: undefined,
    dataDir: undefined,
  }
  return runServerDoctor({ flags, env: effectiveEnv })
}

const sectionVersion = z.literal(SUPPORT_BUNDLE_SCHEMA_VERSION)

// What `status.json` and `record.json` may hold. Declared so the bundle a
// tool reads back is the one the writer was held to.
export const serverSupportBundleStatusSectionSchema = z.discriminatedUnion('ok', [
  z
    .object({
      schemaVersion: sectionVersion,
      state: z.literal('running'),
      ok: z.literal(true),
      pid: z.number(),
      port: z.number(),
      authStrategy: z.literal('oauth-jwt'),
      startedAt: z.string(),
    })
    .strict(),
  z
    .object({
      schemaVersion: sectionVersion,
      state: z.enum(['missing', 'unreadable', 'stale', 'malformed', 'unverifiable']),
      ok: z.literal(false),
    })
    .strict(),
])

export const serverSupportBundleRecordSectionSchema = z.union([
  z
    .object({
      schemaVersion: sectionVersion,
      kind: z.enum(['missing', 'unreadable', 'malformed']),
    })
    .strict(),
  z
    .object({
      schemaVersion: sectionVersion,
      kind: z.enum(['ok', 'stale']),
      pid: z.number(),
      port: z.number(),
      authStrategy: z.literal('oauth-jwt'),
      startedAt: z.string(),
      publicBaseUrlHost: z.string().optional(),
    })
    .strict(),
])

function buildStatusSection(
  outcome: RunServerStatusOutcome,
): z.infer<typeof serverSupportBundleStatusSectionSchema> {
  const r = outcome.result
  if (r.ok && r.state === 'running') {
    return {
      schemaVersion: SUPPORT_BUNDLE_SCHEMA_VERSION,
      state: 'running',
      ok: true,
      pid: r.pid,
      port: r.port,
      authStrategy: r.authStrategy,
      startedAt: r.startedAt,
    }
  }
  return { schemaVersion: SUPPORT_BUNDLE_SCHEMA_VERSION, state: r.state, ok: false }
}

function buildRecordSection(
  readResult: ServerModeRecordReadResult,
  statusOutcome: RunServerStatusOutcome,
): z.infer<typeof serverSupportBundleRecordSectionSchema> {
  if (readResult.kind !== 'ok') {
    return { schemaVersion: SUPPORT_BUNDLE_SCHEMA_VERSION, kind: readResult.kind }
  }
  const r = readResult.record
  // Derive liveness from the identity-verified status outcome so PID reuse
  // cannot produce a false 'ok' when a different process occupies the same PID.
  const kind = statusOutcome.result.ok && statusOutcome.result.state === 'running' ? 'ok' : 'stale'
  let publicBaseUrlHost: string | null = null
  try {
    publicBaseUrlHost = new URL(r.publicBaseUrl).host
  } catch {
    /* empty */
  }
  return {
    schemaVersion: SUPPORT_BUNDLE_SCHEMA_VERSION,
    kind,
    pid: r.pid,
    port: r.port,
    authStrategy: r.authStrategy,
    startedAt: r.startedAt,
    ...(publicBaseUrlHost !== null ? { publicBaseUrlHost } : {}),
  }
}

export async function runServerSupportBundle(
  options: ServerSupportBundleOptions,
): Promise<ServerSupportBundleOutcome> {
  const written = await writeSupportBundle(options.outputDir, () => collectBundle(options))
  return written.kind === 'not-written' ? fail(written.message) : succeeded(written.files)
}

async function collectBundle(options: ServerSupportBundleOptions): Promise<SupportBundle> {
  const {
    dataDir,
    env = process.env,
    now = () => new Date().toISOString(),
    packageVersion = PACKAGE_VERSION,
    platform = { os: process.platform, nodeVersion: process.version },
    doRunStatus = defaultRunStatus,
    doRunDoctor = defaultRunDoctor,
    doReadRecord = readServerModeRecord,
  } = options

  const [statusOutcome, doctorOutcome] = await Promise.all([
    doRunStatus(dataDir),
    doRunDoctor({ dataDir, env }),
  ])
  const readResult = doReadRecord(dataDir)

  // Re-allow-list and run redactStrict on all stringy fields so Authorization /
  // Bearer markers that runServerDoctor preserves for its own diagnostic surface
  // never reach the bundle files.
  const doctorSection = buildDoctorSection(doctorOutcome.result)

  return {
    manifest: {
      schemaVersion: SUPPORT_BUNDLE_SCHEMA_VERSION,
      mode: 'server-mode',
      createdAt: now(),
      packageVersion,
      platform,
      sections: ['status.json', 'doctor.json', 'record.json'],
    },
    sections: {
      'status.json': operatorJsonLine(
        serverSupportBundleStatusSectionSchema,
        buildStatusSection(statusOutcome),
      ),
      'doctor.json': operatorJsonLine(supportBundleDoctorSectionSchema, doctorSection),
      'record.json': operatorJsonLine(
        serverSupportBundleRecordSectionSchema,
        buildRecordSection(readResult, statusOutcome),
      ),
    },
  }
}
