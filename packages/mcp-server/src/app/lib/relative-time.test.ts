import { describe, it, expect } from 'vitest'
import { formatRelativeTime } from './relative-time.js'

// Relative time strings such as "2h ago" for the sidebar.
// Inject `now` so the test stays deterministic.

const NOW = new Date('2026-04-18T12:00:00Z').getTime()

describe('formatRelativeTime', () => {
  it('returns "just now" under 60 seconds', () => {
    expect(formatRelativeTime('2026-04-18T11:59:30Z', NOW)).toBe('just now')
    expect(formatRelativeTime('2026-04-18T12:00:00Z', NOW)).toBe('just now')
  })

  it('returns "Nm ago" from 60 seconds up to 59 minutes', () => {
    expect(formatRelativeTime('2026-04-18T11:59:00Z', NOW)).toBe('1m ago')
    expect(formatRelativeTime('2026-04-18T11:30:00Z', NOW)).toBe('30m ago')
  })

  it('returns "Nh ago" from 60 minutes up to 23 hours', () => {
    expect(formatRelativeTime('2026-04-18T11:00:00Z', NOW)).toBe('1h ago')
    expect(formatRelativeTime('2026-04-18T00:00:00Z', NOW)).toBe('12h ago')
  })

  it('returns "Nd ago" from 24 hours up to 29 days', () => {
    expect(formatRelativeTime('2026-04-17T12:00:00Z', NOW)).toBe('1d ago')
    expect(formatRelativeTime('2026-04-01T12:00:00Z', NOW)).toBe('17d ago')
  })

  it('returns YYYY-MM-DD after 30 days', () => {
    expect(formatRelativeTime('2026-03-01T12:00:00Z', NOW)).toBe('2026-03-01')
  })

  it('treats future timestamps as "just now"', () => {
    // Fallback for clock skew or other impossible future values.
    expect(formatRelativeTime('2026-04-18T12:01:00Z', NOW)).toBe('just now')
  })
})
