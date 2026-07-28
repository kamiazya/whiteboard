import { describe, expect, test } from 'vitest'
import { parseVersionRecord, versionRecordSchema } from './version-record.js'

describe('versionRecordSchema', () => {
  test('accepts a well-formed record', () => {
    const result = versionRecordSchema.safeParse({
      label: 'v1',
      timestamp: '2026-01-01T00:00:00.000Z',
      frontier: 'ab12',
    })
    expect(result.success).toBe(true)
  })

  test('rejects a record with an extra unknown key', () => {
    const result = versionRecordSchema.safeParse({
      label: 'v1',
      timestamp: '2026-01-01T00:00:00.000Z',
      frontier: 'ab12',
      extra: true,
    })
    expect(result.success).toBe(false)
  })

  test('rejects a record with a wrong-typed field', () => {
    const result = versionRecordSchema.safeParse({
      label: 'v1',
      timestamp: '2026-01-01T00:00:00.000Z',
      frontier: 123,
    })
    expect(result.success).toBe(false)
  })
})

describe('parseVersionRecord', () => {
  test('returns the parsed record for well-formed JSON', () => {
    const record = parseVersionRecord(
      JSON.stringify({ label: 'v1', timestamp: '2026-01-01T00:00:00.000Z', frontier: 'ab12' }),
    )
    expect(record).toEqual({
      label: 'v1',
      timestamp: '2026-01-01T00:00:00.000Z',
      frontier: 'ab12',
    })
  })

  test('returns null for malformed JSON', () => {
    expect(parseVersionRecord('not json')).toBeNull()
  })

  test('returns null for well-formed JSON that does not match the schema', () => {
    expect(parseVersionRecord(JSON.stringify({ label: 'v1', frontier: 123 }))).toBeNull()
  })
})
