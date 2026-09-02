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

  // The version timeline's variant: past a day it switches to an absolute
  // M/D HH:MM stamp instead of counting days forever — a parameter on the
  // one formatter, not a fork (the fork existed, and its day-boundary
  // behavior silently diverged from every other list's).
  it("pastDay: 'absolute' switches to M/D HH:MM after 24h, and only then", () => {
    expect(formatRelative('2026-08-22T03:00:00.000Z', { pastDay: 'absolute' })).toBe('9h ago')
    const stamp = formatRelative('2026-08-19T15:04:00.000Z', { pastDay: 'absolute' })
    // Local-time rendering, so assert the shape and the minute field rather
    // than a fixed hour.
    expect(stamp).toMatch(/^8\/19 \d{2}:04$/)
  })

  it("invalid: 'echo' answers the raw string for an unparsable stamp", () => {
    expect(formatRelative('not-a-date', { invalid: 'echo' })).toBe('not-a-date')
  })
})
