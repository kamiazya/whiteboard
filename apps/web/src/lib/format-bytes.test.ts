import { describe, expect, it } from 'vitest'
import { formatBytes } from './format-bytes.js'

describe('formatBytes', () => {
  it('returns "0 B" for zero, negative, or non-finite input', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-100)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B')
  })

  it('uses raw bytes below 1 KiB without decimals', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('bumps to the next unit when rounding would display 1024', () => {
    // 1023.6 B rounds to 1024 — display as 1.0 KiB, never "1024 B".
    expect(formatBytes(1023.6)).toBe('1.0 KiB')
    // 1023.95 KiB → toFixed(1) gives "1024.0" — display as 1.0 MiB.
    expect(formatBytes(1023.95 * 1024)).toBe('1.0 MiB')
    // At the TiB cap there is no next unit; the raw rounding stands.
    expect(formatBytes(1023.95 * 1024 ** 4)).toBe('1024.0 TiB')
  })

  it('uses one decimal at KiB / MiB / GiB scale', () => {
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MiB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GiB')
  })

  it('caps at TiB so very large values do not fall off the unit list', () => {
    const huge = 10 * 1024 ** 4
    expect(formatBytes(huge)).toBe('10.0 TiB')
  })
})
