// `whiteboard server support-bundle --json` helper.
//
// Collects a redacted diagnostic bundle for server-mode operators.
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

import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { hasAncestorSymlink } from '../server/backup-restore.js'
import type { ServerModeRecordReadResult } from '../server/security/server-mode-record.js'
import { readServerModeRecord } from '../server/security/server-mode-record.js'
import {
  buildDoctorSection,
  SUPPORT_BUNDLE_SCHEMA_VERSION,
  supportBundleDoctorSectionSchema,
  supportBundleManifestSchema,
} from '../shared/diagnostics/support-bundle.js'
import { isMissingFileError } from '../shared/errno.js'
import { PACKAGE_VERSION } from '../shared/package-version.js'
import {
  OPERATOR_JSON_SCHEMA_VERSION,
  operatorJsonLine,
  serverSupportBundleOutputSchema,
} from './operator-json.js'
import type { RunServerDoctorOutcome } from './server-doctor.js'
import type { RunServerStatusOutcome } from './server-status.js'

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

function succeeded(): ServerSupportBundleOutcome {
  const stdout = operatorJsonLine(serverSupportBundleOutputSchema, {
    schemaVersion: OPERATOR_JSON_SCHEMA_VERSION,
    ok: true,
    operation: 'support-bundle',
    files: [...ALL_FILES],
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

// Stable write order. manifest.json is last so a reader that sees the
// manifest can trust every section it lists already exists on disk.
const SECTION_WRITE_ORDER = ['status.json', 'doctor.json', 'record.json'] as const
const ALL_FILES = [...SECTION_WRITE_ORDER, 'manifest.json'] as const

export async function runServerSupportBundle(
  options: ServerSupportBundleOptions,
): Promise<ServerSupportBundleOutcome> {
  const {
    dataDir,
    outputDir,
    env = process.env,
    now = () => new Date().toISOString(),
    packageVersion = PACKAGE_VERSION,
    platform = { os: process.platform, nodeVersion: process.version },
    doRunStatus = defaultRunStatus,
    doRunDoctor = defaultRunDoctor,
    doReadRecord = readServerModeRecord,
  } = options

  // ── Output-dir path safety ────────────────────────────────────────

  // Reject if any ancestor path component is a symlink.
  try {
    if (await hasAncestorSymlink(outputDir)) {
      return fail('support bundle refused: output path is not a safe directory.')
    }
  } catch {
    return fail('support bundle failed')
  }

  // Reject symlink or plain-file final component; accept missing or
  // existing empty directory.
  try {
    const st = await lstat(outputDir)
    if (!st.isDirectory()) {
      return fail('support bundle refused: output path is not a safe directory.')
    }
    const entries = await readdir(outputDir)
    if (entries.length > 0) {
      return fail('Could not write support bundle. The output directory must be empty.')
    }
  } catch (err) {
    if (!isMissingFileError(err)) {
      return fail('support bundle failed')
    }
    // Missing output dir: create it.
    try {
      await mkdir(outputDir, { recursive: true })
    } catch {
      return fail('support bundle failed')
    }
  }

  // ── Collect data ─────────────────────────────────────────────────

  const [statusOutcome, doctorOutcome] = await Promise.all([
    doRunStatus(dataDir),
    doRunDoctor({ dataDir, env }),
  ])
  const readResult = doReadRecord(dataDir)

  // ── Build sections ───────────────────────────────────────────────

  const statusSection = buildStatusSection(statusOutcome)
  // Re-allow-list and run redactStrict on all stringy fields so Authorization /
  // Bearer markers that runServerDoctor preserves for its own diagnostic surface
  // never reach the bundle files.
  const doctorSection = buildDoctorSection(doctorOutcome.result)
  const recordSection = buildRecordSection(readResult, statusOutcome)

  const sectionContents: Record<(typeof SECTION_WRITE_ORDER)[number], string> = {
    'status.json': operatorJsonLine(serverSupportBundleStatusSectionSchema, statusSection),
    'doctor.json': operatorJsonLine(supportBundleDoctorSectionSchema, doctorSection),
    'record.json': operatorJsonLine(serverSupportBundleRecordSectionSchema, recordSection),
  }

  const manifestContent = operatorJsonLine(supportBundleManifestSchema, {
    schemaVersion: SUPPORT_BUNDLE_SCHEMA_VERSION,
    mode: 'server-mode',
    createdAt: now(),
    packageVersion,
    platform,
    sections: [...SECTION_WRITE_ORDER],
  })

  // ── Write to disk (manifest last, wx race guard) ─────────────────

  try {
    await Promise.all(
      SECTION_WRITE_ORDER.map((name) =>
        writeFile(join(outputDir, name), sectionContents[name], { encoding: 'utf-8', flag: 'wx' }),
      ),
    )
    await writeFile(join(outputDir, 'manifest.json'), manifestContent, {
      encoding: 'utf-8',
      flag: 'wx',
    })
  } catch {
    return fail('support bundle failed')
  }

  return succeeded()
}
