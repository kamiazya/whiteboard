import { z } from 'zod'
import { type DaemonDoctorResult, doctorCheckStatusSchema } from '../api-contracts/daemon-doctor.js'
import { isIsoDatetime } from './iso-datetime.js'
import { redactDiagnosticText, scrubAuthMarkers } from './redact.js'

// The shared redactor keeps the `Authorization: Bearer [REDACTED]` marker, which
// the support bundle must not carry: see `scrubAuthMarkers`.
function redactStrict(text: string): string {
  return scrubAuthMarkers(redactDiagnosticText(text))
}

// Same shape `createdAt` enforces; `record.startedAt` is a structural
// timestamp, so an arbitrary string must not flow verbatim into status.json.
function assertIsoTimestamp(value: string, label: string): string {
  if (!isIsoDatetime(value)) {
    // Generic message — never echoes the offending input value.
    throw new SupportBundleError(`Invalid ${label}: expected ISO 8601 datetime with offset.`)
  }
  return value
}

// Local-only support bundle, v0. Produces a deterministic in-memory
// {manifest, files} object that maintainers can write to a directory
// caller-side. No public upload, no telemetry, no crash reporting.
//
// The helper is the single funnel for what reaches the bundle: every
// section (status, doctor) is rebuilt through a tight allow-list
// from typed inputs. Raw `DaemonStatusResult` / `DaemonDoctorResult` /
// log-source objects are NOT stringified wholesale — that pattern has
// shipped Authorization / token / canvas-plaintext leaks before, and
// the redactor is a defence-in-depth net, not a primary boundary. There is
// no log section: the daemon writes its records to stderr and keeps no file
// to bundle.
//
// Excluded by contract:
//   - canvas plaintext (Excalidraw scene / elements / files / rawPayload)
//   - migration bundle payload
//   - raw MCP tool input / output
//   - tokens (daemon token / PAT / cookie / session / pairing material)
//   - absolute local paths (the `dataDir` etc. become `[REDACTED_PATH]`
//     via the redactor; structural fields like `pid`/`status`
//     pass the allow-list)
//   - Problem Details `detail` strings
//   - raw `Error.message` from caller-side throws

export const SUPPORT_BUNDLE_SCHEMA_VERSION = 1

const daemonBundleSectionSchema = z.enum(['manifest.json', 'status.json', 'doctor.json'])

// Server mode carries the record it was started from.
const serverBundleSectionSchema = z.enum(['status.json', 'doctor.json', 'record.json'])

const manifestCommon = {
  schemaVersion: z.literal(SUPPORT_BUNDLE_SCHEMA_VERSION),
  // ISO 8601 datetime with timezone offset; consumers ordering bundles by
  // createdAt should never see a malformed value.
  createdAt: z.string().datetime({ offset: true }),
  packageVersion: z.string(),
  platform: z
    .object({
      os: z.string(),
      nodeVersion: z.string(),
    })
    .strict(),
}

// The one declaration of what `manifest.json` may hold, whichever command
// wrote it: `mode` says which bundle this is, and with it which sections.
// Names of the files included in a bundle (excluding the manifest itself),
// pinned to an enum so a new section requires explicit schema acknowledgement.
export const supportBundleManifestSchema = z.discriminatedUnion('mode', [
  z
    .object({
      ...manifestCommon,
      mode: z.literal('daemon'),
      sections: z.array(daemonBundleSectionSchema),
    })
    .strict(),
  z
    .object({
      ...manifestCommon,
      mode: z.literal('server-mode'),
      sections: z.array(serverBundleSectionSchema),
    })
    .strict(),
])
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
  record?: { pid: number; version: string; startedAt: string }
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
  record: { pid: number; version: string; startedAt: string } | null
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
// through the redactor. The input is the doctor result itself, so a check or a
// status added there reaches the bundle without a second edit.
export type SupportBundleDoctorInput = Omit<DaemonDoctorResult, 'schemaVersion'>

export const supportBundleDoctorSectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    ok: z.boolean(),
    status: doctorCheckStatusSchema,
    checks: z.array(
      z
        .object({
          id: z.string(),
          status: doctorCheckStatusSchema,
          summary: z.string(),
          detail: z.string().nullable(),
          remediation: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict()
export type SupportBundleDoctorSection = z.infer<typeof supportBundleDoctorSectionSchema>

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
}

export interface SupportBundle {
  manifest: SupportBundleManifest
  // Deterministic file map. Keys are stable section names; values
  // are JSON strings exactly as a maintainer would write
  // to disk. Iteration order is the same as `manifest.sections`
  // plus the manifest itself, so a directory write produces a
  // deterministic layout.
  files: {
    'manifest.json': string
    'status.json': string
    'doctor.json': string
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
    mode: 'daemon',
    createdAt: input.createdAt,
    packageVersion: input.packageVersion,
    platform: input.platform,
    sections: ['status.json', 'doctor.json'],
  })
  if (!manifestParsed.success) {
    throw new SupportBundleError('Invalid support bundle manifest input.')
  }
  const manifest = manifestParsed.data

  const status = buildStatusSection(input.status)
  const doctor = buildDoctorSection(input.doctor)

  return {
    manifest,
    files: {
      'manifest.json': `${JSON.stringify(manifest)}\n`,
      'status.json': `${JSON.stringify(status)}\n`,
      'doctor.json': `${JSON.stringify(doctor)}\n`,
    },
  }
}
