import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatRelative } from './format-relative.js'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-22T12:00:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('formatRelative', () => {
  it('walks the unit ladder', () => {
    expect(formatRelative('2026-08-22T11:59:30.000Z')).toBe('30s ago')
    expect(formatRelative('2026-08-22T11:05:00.000Z')).toBe('55m ago')
    expect(formatRelative('2026-08-22T03:00:00.000Z')).toBe('9h ago')
    expect(formatRelative('2026-08-19T12:00:00.000Z')).toBe('3d ago')
  })

  // Clock drift between client and daemon can put the stamp in the future;
  // the clamp keeps the label from reading "-5s ago".
  it('clamps a future stamp to 0s', () => {
    expect(formatRelative('2026-08-22T12:00:05.000Z')).toBe('0s ago')
  })

  it('renders nothing for an unparsable stamp', () => {
    expect(formatRelative('not-a-date')).toBe('')
  })
})
