// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { expectLoggedFailure, formatLoggedFailure, recordLoggedFailure } from './logged-failures.js'

describe('formatLoggedFailure', () => {
  it('is the spelling a record is matched and reported in', async () => {
    recordLoggedFailure('warn', ['startup fold left documents behind', { left: 2 }])
    await expectLoggedFailure('{"left":2}')
  })

  it('keeps the data object a logger passes after its message', () => {
    const record = formatLoggedFailure('warn', ['msg', { left: 2 }])
    expect(record).toContain('left')
    expect(record).not.toContain('[object Object]')
  })

  it('names an Error by its name and message', () => {
    expect(formatLoggedFailure('error', ['boom', new TypeError('bad input')])).toBe(
      'error: boom TypeError: bad input',
    )
  })

  it('falls back to String for a value JSON cannot hold', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(formatLoggedFailure('warn', ['x', cyclic])).toBe('warn: x [object Object]')
  })

  it('caps a large payload so the failure message stays readable', () => {
    const record = formatLoggedFailure('warn', ['x', { big: 'y'.repeat(10_000) }])
    expect(record.length).toBeLessThan(1_000)
  })
})
