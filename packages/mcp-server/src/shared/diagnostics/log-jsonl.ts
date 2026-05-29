import { z } from 'zod'
import { type RedactionOptions, redactDiagnosticText, redactDiagnosticValue } from './redact.js'

// Stable JSONL surface for daemon / CLI / runtime logs. The shape is
// the contract that future `whiteboard daemon logs --json` and any
// support-bundle assembly will both serialize against.
//
// JSONL (newline-delimited JSON) is intentionally chosen over an
// array wrapper:
//   - one line per entry → grep / cut / jq -c streaming friendly
//   - cheap to append a single line (a future --follow flow can
//     write incrementally without rewriting the whole array)
//   - a partially-written tail still parses up to the last \n
//
// Every line is independently `JSON.parse`-able. The whole stdout is
// NOT a single JSON document — `JSON.parse(stdout)` is intentionally
// unsupported.
//
// Redaction is layered:
//   - producer allow-list: `fields` accepts only the operational
//     field names listed below; everything else is dropped, even if
//     the value would have looked safe. Canvas plaintext / scene
//     elements / arbitrary user content never reach the redactor at
//     all because they never make it past the allow-list.
//   - sentinel scrub: each surviving value (and `message`) is run
//     through `redactDiagnosticText` / `redactDiagnosticValue` so
//     accidental token / path / stack-frame leaks become the usual
//     `[REDACTED_*]` sentinel strings.

export const DAEMON_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type DaemonLogLevel = (typeof DAEMON_LOG_LEVELS)[number]

export const DAEMON_LOG_SOURCES = ['daemon', 'runtime', 'doctor', 'server', 'mcp'] as const
export type DaemonLogSource = (typeof DAEMON_LOG_SOURCES)[number]

// Operational fields that producers are allowed to surface in JSONL
// output. Anything outside this set is dropped at format time. The
// list is intentionally tight — adding a new entry is a deliberate
// ack that the field's value is safe to render verbatim (after the
// downstream sentinel scrub) and that the reader will know what it
// means without further context.
//
// `workspaceId` is deliberately NOT in this allow-list: it would
// expose which workspace a log line came from to anyone reading the
// stream. Add it later only if a concrete operational need motivates
// the trade-off.
export const OPERATIONAL_FIELD_ALLOWLIST = new Set<string>([
  'checkId',
  'remediationId',
  'status',
  'code',
  'version',
  'platform',
  'pid',
  'port',
])

// Defence-in-depth deny-list for field names that are obvious
// canvas-plaintext / payload carriers. The allow-list above already
// excludes them, but listing the deny-list explicitly makes the
// intent grep-friendly and gives a future producer that mistakenly
// adds one of these names to the allow-list a second wall to hit.
export const CANVAS_PLAINTEXT_DENYLIST = new Set<string>([
  'canvasText',
  'elementText',
  'scene',
  'elements',
  'files',
  'rawPayload',
  'requestHeaders',
  'authorization',
  'token',
])

// `fields` is a free-form record of JSON-compatible values. The
// shape contract is "an object whose values round-trip through
// JSON.stringify"; the producer allow-list and the value scrub
// (`redactDiagnosticValue`) enforce the *content* contract. Zod
// only needs to confirm the outer shape, so each value is `unknown`.
// Timestamps are an ISO 8601 datetime string with a timezone offset
// (or `Z`). Anything looser would let `timestamp: "not-a-date"` pass
// schema parse and break downstream consumers that order log entries
// by time.
export const daemonLogEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    timestamp: z.string().datetime({ offset: true }),
    level: z.enum(DAEMON_LOG_LEVELS),
    source: z.enum(DAEMON_LOG_SOURCES),
    message: z.string(),
    fields: z.record(z.string(), z.unknown()),
  })
  .strict()

export type DaemonLogEntry = z.infer<typeof daemonLogEntrySchema>

// Loose input shape — what producers pass in before allow-list +
// sentinel scrub. `fields` is a free record so this helper can be
// the single funnel even when callers don't yet know whether a key
// is allow-listed. `timestamp` (when present) MUST be an ISO 8601
// datetime; the helper fails closed on anything else rather than
// silently emitting a malformed log line.
export interface DaemonLogEntryInput {
  timestamp?: string
  level: DaemonLogLevel
  source: DaemonLogSource
  message: string
  fields?: Record<string, unknown>
}

export class InvalidLogTimestampError extends Error {
  override readonly name = 'InvalidLogTimestampError'
  constructor() {
    super('Invalid log timestamp: expected an ISO 8601 datetime string with a timezone offset.')
  }
}

const EPOCH_ISO = new Date(0).toISOString()
// Lightweight ISO 8601 check that matches the same shape Zod's
// `.datetime({ offset: true })` accepts (millisecond precision is
// optional; offset can be `Z` or `±HH:MM`). Keeping the regex local
// avoids a round-trip through Zod for every emitted entry.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function normalizeTimestamp(input: string | undefined): string {
  if (input === undefined) return EPOCH_ISO
  if (!ISO_DATETIME_RE.test(input)) throw new InvalidLogTimestampError()
  // Belt-and-suspenders: reject "2026-13-40T..." style values that
  // pass the regex but produce NaN through Date.parse.
  if (Number.isNaN(Date.parse(input))) throw new InvalidLogTimestampError()
  return input
}

// Drop the `Authorization` / `Bearer` marker keywords from a string
// AFTER the shared redactor has already scrubbed the token value.
// The shared redactor preserves the marker on purpose (e.g. for the
// doctor diagnostic surface where "Authorization: Bearer [REDACTED]"
// is informative). The JSONL surface is consumed by support bundles
// and live log streams where even the marker word is unwelcome — a
// reader scanning for "Bearer" / "Authorization" should never have to
// distinguish "actual leak" from "redacted marker".
const AUTH_MARKER_RE = /(?:Authorization\s*:\s*)?\bBearer\s*\[REDACTED\]/gi
const BARE_AUTH_HEADER_MARKER_RE = /Authorization\s*:\s*\[REDACTED\]/gi

function scrubAuthMarkers(text: string): string {
  return text
    .replace(AUTH_MARKER_RE, '[REDACTED_AUTH]')
    .replace(BARE_AUTH_HEADER_MARKER_RE, '[REDACTED_AUTH]')
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubAuthMarkers(value)
  if (Array.isArray(value)) return value.map(scrubValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubValue(v)
    }
    return out
  }
  return value
}

function pickAllowedFields(
  input: Record<string, unknown> | undefined,
  options?: RedactionOptions,
): Record<string, unknown> {
  if (!input) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (CANVAS_PLAINTEXT_DENYLIST.has(key)) continue
    if (!OPERATIONAL_FIELD_ALLOWLIST.has(key)) continue
    out[key] = scrubValue(redactDiagnosticValue(value, options))
  }
  return out
}

// Produce a redacted, schema-shaped entry. The output is safe to
// JSON.stringify and matches `daemonLogEntrySchema`.
export function redactDaemonLogEntry(
  input: DaemonLogEntryInput,
  options?: RedactionOptions,
): DaemonLogEntry {
  return {
    schemaVersion: 1,
    timestamp: normalizeTimestamp(input.timestamp),
    level: input.level,
    source: input.source,
    message: scrubAuthMarkers(redactDiagnosticText(input.message, options)),
    fields: pickAllowedFields(input.fields, options),
  }
}

// Format one redacted entry as a single newline-terminated JSON line.
// `\n` belongs to the line itself so concatenating lines yields a
// well-formed JSONL stream without extra glue.
export function formatDaemonLogEntryAsJsonLine(
  input: DaemonLogEntryInput,
  options?: RedactionOptions,
): string {
  const redacted = redactDaemonLogEntry(input, options)
  return `${JSON.stringify(redacted)}\n`
}

// Format N entries as a concatenated JSONL stream. Empty input
// produces empty output (no spurious newline). Non-empty input
// always ends with a trailing newline.
export function formatDaemonLogEntriesAsJsonLines(
  inputs: readonly DaemonLogEntryInput[],
  options?: RedactionOptions,
): string {
  if (inputs.length === 0) return ''
  let out = ''
  for (const entry of inputs) {
    out += formatDaemonLogEntryAsJsonLine(entry, options)
  }
  return out
}
