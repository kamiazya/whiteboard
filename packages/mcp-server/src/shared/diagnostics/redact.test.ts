import { describe, expect, it } from 'vitest'
import { redactDiagnosticText, redactDiagnosticValue } from './redact.js'

describe('redactDiagnosticText', () => {
  it('replaces a bearer token and an absolute path', () => {
    expect(redactDiagnosticText('GET /Users/me/project/x.ts with Bearer abc.def')).toBe(
      'GET [REDACTED_PATH] with Bearer [REDACTED]',
    )
  })

  it('has no way to keep a path: a stray second argument changes nothing', () => {
    // @ts-expect-error the redactor takes no options
    expect(redactDiagnosticText('/opt/wb/server.ts', { keepPaths: true })).toBe('[REDACTED_PATH]')
  })
})

describe('redactDiagnosticValue', () => {
  it('redacts strings at every depth and leaves other values alone', () => {
    expect(redactDiagnosticValue({ a: ['/etc/passwd', 3, null], b: { c: 'Bearer t0k' } })).toEqual({
      a: ['[REDACTED_PATH]', 3, null],
      b: { c: 'Bearer [REDACTED]' },
    })
  })

  it('names what it cannot serialise rather than passing it through', () => {
    expect(redactDiagnosticValue(10n)).toBe('[REDACTED_NON_SERIALIZABLE]')
  })
})
