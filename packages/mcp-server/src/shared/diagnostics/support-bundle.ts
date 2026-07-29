import { z } from 'zod'
import { type DaemonLogEntryInput, formatDaemonLogEntriesAsJsonLines } from './log-jsonl.js'
import { redactDiagnosticText } from './redact.js'

// Same auth-marker scrub the JSONL surface applies. The shared
// redactor keeps the `Authorization: Bearer [REDACTED]` marker on
// purpose for the doctor diagnostic surface, but the support bundle
// is consumed by maintainers grepping for "Bearer" / "Authorization"
// across files — even the marker word is unwelcome there.
const AUTH_MARKER_RE = /(?:Authorization\s*:\s*)?\bBearer\s*\[REDACTED\]/gi
const BARE_AUTH_HEADER_MARKER_RE = /Authorization\s*:\s*\[REDACTED\]/gi
function scrubAuthMarkers(text: string): string {
  return text
    .replace(AUTH_MARKER_RE, '[REDACTED_AUTH]')
    .replace(BARE_AUTH_HEADER_MARKER_RE, '[REDACTED_AUTH]')
}
function redactStrict(text: string): string {
  return scrubAuthMarkers(redactDiagnosticText(text))
}

// ISO 8601 datetime with timezone offset — same shape `createdAt`
// enforces. Used for `record.startedAt`, which is a structural
// timestamp field; tolerating arbitrary strings here would let a
// caller smuggle Authorization / paths / stack frames into
// status.json untouched, since the timestamp shape would otherwise
// flow verbatim into the JSON.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function assertIsoTimestamp(value: string, label: string): string {
  if (!ISO_DATETIME_RE.test(value)) {
    // Generic message — never echoes the offending input value.
    throw new SupportBundleError(`Invalid ${label}: expected ISO 8601 datetime with offset.`)
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new SupportBundleError(`Invalid ${label}: expected ISO 8601 datetime with offset.`)
  }
  return value
}

// Local-only support bundle, v0. Produces a deterministic in-memory
// {manifest, files} object that maintainers can write to a directory
// caller-side. No public upload, no telemetry, no crash reporting.
//
// The helper is the single funnel for what reaches the bundle: every
// section (status, doctor, logs) is rebuilt through a tight allow-list
// from typed inputs. Raw `DaemonStatusResult` / `DaemonDoctorResult` /
// log-source objects are NOT stringified wholesale — that pattern has
// shipped Authorization / token / canvas-plaintext leaks before, and
// the redactor is a defence-in-depth net, not a primary boundary.
//
// Excluded by contract:
//   - canvas plaintext (Excalidraw scene / elements / files / rawPayload)
//   - migration bundle payload
//   - raw MCP tool input / output
//   - tokens (daemon token / PAT / cookie / session / pairing material)
//   - absolute local paths (the `dataDir` etc. become `[REDACTED_PATH]`
//     via the redactor; structural fields like `pid`/`port`/`status`
//     pass the allow-list)
//   - Problem Details `detail` strings
//   - raw `Error.message` from caller-side throws

export const SUPPORT_BUNDLE_SCHEMA_VERSION = 1

const supportBundleSectionSchema = z.enum([
  'manifest.json',
  'status.json',
  'doctor.json',
  'logs.jsonl',
])

export const supportBundleManifestSchema = z
  .object({
    schemaVersion: z.literal(SUPPORT_BUNDLE_SCHEMA_VERSION),
    // ISO 8601 datetime with timezone offset. Same shape the JSONL
    // surface enforces; consumers ordering bundles by createdAt
    // should never see a malformed value.
    createdAt: z.string().datetime({ offset: true }),
    packageVersion: z.string(),
    platform: z
      .object({
        os: z.string(),
        nodeVersion: z.string(),
      })
      .strict(),
    // Names of the files included in this bundle (excluding the
    // manifest itself). Pinned to the section enum so a new section
    // requires explicit schema acknowledgement.
    sections: z.array(supportBundleSectionSchema),
  })
  .strict()
type SupportBundleManifest = z.infer<typeof supportBundleManifestSchema>

// Redacted status section. Mirrors `DaemonStatusResult` but only the
// fields we explicitly want to expose. `record.token`,
// `auth.hasToken`, `mcp.endpoint`, anything path-shaped goes through
// the redactor or never copies.
interface SupportBundleStatusInput {
  ok: boolean
  reason: string | null
  recordFound: boolean
  recordFresh: boolean
  pidAlive?: boolean
  pingOk?: boolean
  statusOk?: boolean
  record?: { pid: number; port: number; version: string; startedAt: string }
}

interface SupportBundleStatusSection {
  schemaVersion: 1
  ok: boolean
  reason: string | null
  recordFound: boolean
  recordFresh: boolean
  pidAlive: boolean | null
  pingOk: boolean | null
  statusOk: boolean | null
  record: { pid: number; port: number; version: string; startedAt: string } | null
}

function buildStatusSection(input: SupportBundleStatusInput): SupportBundleStatusSection {
  return {
    schemaVersion: 1,
    ok: input.ok,
    reason: input.reason === null ? null : redactStrict(input.reason),
    recordFound: input.recordFound,
    recordFresh: input.recordFresh,
    pidAlive: input.pidAlive ?? null,
    pingOk: input.pingOk ?? null,
    statusOk: input.statusOk ?? null,
    record: input.record
      ? {
          pid: input.record.pid,
          port: input.record.port,
          version: redactStrict(input.record.version),
          // ISO-validated rather than redacted: the redactor would
          // mangle the timestamp shape, but flowing it through
          // verbatim let a caller smuggle leaky strings into the
          // bundle. Fail closed on anything that isn't an ISO 8601
          // datetime with offset.
          startedAt: assertIsoTimestamp(input.record.startedAt, 'record.startedAt'),
        }
      : null,
  }
}

// Redacted doctor section. The doctor result has a list of checks
// with id/status/summary/detail/remediation; everything stringy runs
// through the redactor.
interface SupportBundleDoctorCheckInput {
  id: string
  status: 'ok' | 'warning' | 'error' | 'skipped'
  summary: string
  detail?: string
  remediation?: string
}
export interface SupportBundleDoctorInput {
  ok: boolean
  status: 'ok' | 'warning' | 'error' | 'skipped'
  checks: SupportBundleDoctorCheckInput[]
}
export interface SupportBundleDoctorSection {
  schemaVersion: 1
  ok: boolean
  status: 'ok' | 'warning' | 'error' | 'skipped'
  checks: Array<{
    id: string
    status: 'ok' | 'warning' | 'error' | 'skipped'
    summary: string
    detail: string | null
    remediation: string | null
  }>
}

export function buildDoctorSection(input: SupportBundleDoctorInput): SupportBundleDoctorSection {
  return {
    schemaVersion: 1,
    ok: input.ok,
    status: input.status,
    checks: input.checks.map((c) => ({
      id: c.id,
      status: c.status,
      summary: redactStrict(c.summary),
      detail: c.detail === undefined ? null : redactStrict(c.detail),
      remediation: c.remediation === undefined ? null : redactStrict(c.remediation),
    })),
  }
}

export interface SupportBundleInput {
  createdAt: string
  packageVersion: string
  platform: { os: string; nodeVersion: string }
  status: SupportBundleStatusInput
  doctor: SupportBundleDoctorInput
  // Producer-supplied log entries. Each entry runs through
  // `formatDaemonLogEntriesAsJsonLines` (allow-list + sentinel
  // scrub + ISO timestamp normalisation + JSONL framing).
  logs: DaemonLogEntryInput[]
}

export interface SupportBundle {
  manifest: SupportBundleManifest
  // Deterministic file map. Keys are stable section names; values
  // are JSON or JSONL strings exactly as a maintainer would write
  // to disk. Iteration order is the same as `manifest.sections`
  // plus the manifest itself, so a directory write produces a
  // deterministic layout.
  files: {
    'manifest.json': string
    'status.json': string
    'doctor.json': string
    'logs.jsonl': string
  }
}

export class SupportBundleError extends Error {
  override readonly name = 'SupportBundleError'
}

export function buildSupportBundle(input: SupportBundleInput): SupportBundle {
  // Validate manifest shape up front so a malformed `createdAt`
  // fails closed before we serialize any section. Echoing the input
  // is intentionally avoided — `SupportBundleError.message` is
  // generic so a future support-bundle CLI cannot leak the bad
  // value.
  const manifestParsed = supportBundleManifestSchema.safeParse({
    schemaVersion: SUPPORT_BUNDLE_SCHEMA_VERSION,
    createdAt: input.createdAt,
    packageVersion: input.packageVersion,
    platform: input.platform,
    sections: ['status.json', 'doctor.json', 'logs.jsonl'],
  })
  if (!manifestParsed.success) {
    throw new SupportBundleError('Invalid support bundle manifest input.')
  }
  const manifest = manifestParsed.data

  const status = buildStatusSection(input.status)
  const doctor = buildDoctorSection(input.doctor)
  const logsJsonl = formatDaemonLogEntriesAsJsonLines(input.logs)

  return {
    manifest,
    files: {
      'manifest.json': `${JSON.stringify(manifest)}\n`,
      'status.json': `${JSON.stringify(status)}\n`,
      'doctor.json': `${JSON.stringify(doctor)}\n`,
      'logs.jsonl': logsJsonl,
    },
  }
}
