import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { safeErrorCopy } from './error-copy.js'

describe('safeErrorCopy — deterministic cases', () => {
  it('returns body.title for Problem Details objects (RFC 9457)', () => {
    const err = {
      status: 409,
      body: {
        type: 'https://example.com/problems/branch_conflict',
        title: 'Branch already exists',
        status: 409,
      },
    }
    expect(safeErrorCopy(err, 'fallback')).toBe('Branch already exists')
  })

  it('returns fallback for Error instances — never exposes err.message', () => {
    expect(safeErrorCopy(new Error('internal: token=secret-abc'), 'fallback')).toBe('fallback')
  })

  it('returns fallback for a bare body.message with no error code', () => {
    // Without a code the message is out of contract — it could be anything,
    // so it stays unforwarded.
    const err = { status: 400, body: { message: 'Name too long' } }
    expect(safeErrorCopy(err, 'fallback')).toBe('fallback')
  })

  it('forwards body.message when it accompanies an error code (the branch routes)', () => {
    // Red-first for the audited defect: the daemon's real reason was
    // discarded and users saw only the generic fallback.
    const err = {
      status: 409,
      body: { error: 'branch_conflict', message: 'A variation named "x" already exists' },
    }
    expect(safeErrorCopy(err, 'Failed to create variation')).toBe(
      'A variation named "x" already exists',
    )
  })

  it('returns fallback when body has neither title nor message', () => {
    const err = { status: 409, body: { error: 'branch_conflict' } }
    expect(safeErrorCopy(err, 'Something went wrong.')).toBe('Something went wrong.')
  })

  it('returns fallback when body is absent', () => {
    expect(safeErrorCopy({ status: 500 }, 'Server error.')).toBe('Server error.')
  })

  it('returns fallback for null', () => {
    expect(safeErrorCopy(null, 'fallback')).toBe('fallback')
  })

  it('returns fallback for undefined', () => {
    expect(safeErrorCopy(undefined, 'fallback')).toBe('fallback')
  })

  it('returns fallback for primitives', () => {
    expect(safeErrorCopy(42, 'fallback')).toBe('fallback')
    expect(safeErrorCopy('raw string', 'fallback')).toBe('fallback')
  })

  it('ignores empty body.title and returns fallback', () => {
    expect(safeErrorCopy({ status: 400, body: { title: '' } }, 'fallback')).toBe('fallback')
  })

  it('does not serialize raw JSON of a BranchApiError-shaped object', () => {
    const err = {
      status: 409,
      body: { type: 'https://example.com/problems/conflict', title: 'Conflict', status: 409 },
    }
    const result = safeErrorCopy(err, 'fallback')
    expect(result).not.toContain('{')
    expect(result).not.toContain('https://')
    expect(result).toBe('Conflict')
  })
})

describe('safeErrorCopy — property tests (P-HTTP-005)', () => {
  // Error.message must never reach the UI regardless of content.
  // This is the primary P-HTTP-005 guarantee: stack traces, local paths, and tokens
  // thrown as Error objects are always replaced by fallback.
  fcTest.prop([fc.string()], withDefaults())(
    'Error.message is never forwarded to the UI',
    (message) => {
      const result = safeErrorCopy(new Error(message), 'FALLBACK')
      expect(result).toBe('FALLBACK')
    },
  )

  // body.message must never reach the UI (not a standard RFC 9457 field).
  fcTest.prop([fc.string()], withDefaults())(
    'body.message is never forwarded even without body.title',
    (message) => {
      const err = { status: 400, body: { message } }
      const result = safeErrorCopy(err, 'FALLBACK')
      expect(result).toBe('FALLBACK')
    },
  )

  // Sensitive patterns inside Error.message must not leak.
  const sensitiveMessage = fc.oneof(
    // Authorization header value
    fc.string().map((s) => `Authorization: Bearer ${s}`),
    // Local filesystem path
    fc.string().map((s) => `/Users/${s}/config.json`),
    // Stack-like string
    fc.string().map((s) => `Error: at ${s} (${s}:1:2)\n    at Object.<anonymous> (${s}:3:4)`),
    // Problem Details type URL (should not appear in UI via Error.message)
    fc.string().map((s) => `https://example.com/problems/${s}`),
  )

  fcTest.prop([sensitiveMessage], withDefaults())(
    'sensitive patterns in Error.message never reach output',
    (message) => {
      const result = safeErrorCopy(new Error(message), 'FALLBACK')
      expect(result).toBe('FALLBACK')
    },
  )

  // body.title IS allowed through — it is RFC 9457-designed for display.
  // Verify a non-empty title string always reaches the output.
  fcTest.prop([fc.string({ minLength: 1 })], withDefaults())(
    'non-empty body.title is forwarded as the display copy',
    (title) => {
      const err = { status: 400, body: { title } }
      const result = safeErrorCopy(err, 'FALLBACK')
      expect(result).toBe(title)
    },
  )
})
