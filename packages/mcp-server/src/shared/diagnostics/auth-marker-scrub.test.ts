import { describe, expect, it } from 'vitest'
import { redactDaemonLogEntry } from './log-jsonl.js'
import { scrubAuthMarkers } from './redact.js'
import { buildDoctorSection } from './support-bundle.js'

// Text the shared redactor has already left carrying a marker, with what a
// surface that wants no `Bearer` / `Authorization` keyword must print.
const CORPUS: readonly { readonly input: string; readonly expected: string }[] = [
  { input: 'Authorization: Bearer [REDACTED]', expected: '[REDACTED_AUTH]' },
  { input: 'Authorization : Bearer [REDACTED]', expected: '[REDACTED_AUTH]' },
  { input: 'Bearer [REDACTED]', expected: '[REDACTED_AUTH]' },
  { input: 'BEARER[REDACTED]', expected: '[REDACTED_AUTH]' },
  { input: 'Authorization: [REDACTED]', expected: '[REDACTED_AUTH]' },
  { input: 'authorization:[REDACTED]', expected: '[REDACTED_AUTH]' },
  {
    input: 'retry with Bearer [REDACTED] then Authorization: [REDACTED] again',
    expected: 'retry with [REDACTED_AUTH] then [REDACTED_AUTH] again',
  },
  { input: 'Bearerish [REDACTED]', expected: 'Bearerish [REDACTED]' },
  { input: 'no markers here', expected: 'no markers here' },
]

describe('auth-marker scrub', () => {
  it.each(CORPUS)('scrubAuthMarkers rewrites %j', ({ input, expected }) => {
    expect(scrubAuthMarkers(input)).toBe(expected)
  })

  it.each(CORPUS)('the JSONL log surface and the support-bundle surface agree on %j', ({
    input,
    expected,
  }) => {
    const logMessage = redactDaemonLogEntry({
      level: 'info',
      source: 'daemon',
      message: input,
    }).message
    const bundleSummary = buildDoctorSection({
      ok: true,
      status: 'ok',
      checks: [{ id: 'check', status: 'ok', summary: input }],
    }).checks[0]?.summary
    expect(logMessage).toBe(expected)
    expect(bundleSummary).toBe(expected)
  })
})
