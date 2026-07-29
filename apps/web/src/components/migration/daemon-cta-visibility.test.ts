import { describe, expect, it } from 'vitest'
import type { DaemonProbeResult } from '../../lib/daemon-probe.js'
import { defaultUserSettings, type UserSettings } from '../../lib/user-settings-store.js'
import { shouldShowDaemonCta } from './daemon-cta-visibility.js'

const NOW = new Date('2026-07-11T00:00:00.000Z')
const DETECTED: DaemonProbeResult = { detected: true, instanceId: 'inst-1' }
const NOT_DETECTED: DaemonProbeResult = { detected: false, reason: 'timeout' }

function withStorage(overrides: Partial<UserSettings['storage']>): UserSettings {
  const base = defaultUserSettings()
  return { ...base, storage: { ...base.storage, ...overrides } }
}

describe('shouldShowDaemonCta', () => {
  it('shows when probe detected and never dismissed', () => {
    expect(shouldShowDaemonCta(defaultUserSettings(), DETECTED, NOW)).toBe(true)
  })

  it('hides when dismissed with the same instanceId 1ms under 14 days', () => {
    const dismissedAt = new Date(NOW.getTime() - 14 * 24 * 60 * 60 * 1000 + 1).toISOString()
    const settings = withStorage({
      dismissedDaemonCtaAt: dismissedAt,
      dismissedDaemonCtaInstanceId: 'inst-1',
    })
    expect(shouldShowDaemonCta(settings, DETECTED, NOW)).toBe(false)
  })

  it('shows at exactly 14 days (boundary inclusive-show)', () => {
    const dismissedAt = new Date(NOW.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
    const settings = withStorage({
      dismissedDaemonCtaAt: dismissedAt,
      dismissedDaemonCtaInstanceId: 'inst-1',
    })
    expect(shouldShowDaemonCta(settings, DETECTED, NOW)).toBe(true)
  })

  it('shows when the instanceId differs from the dismissed one', () => {
    const settings = withStorage({
      dismissedDaemonCtaAt: NOW.toISOString(),
      dismissedDaemonCtaInstanceId: 'inst-OTHER',
    })
    expect(shouldShowDaemonCta(settings, DETECTED, NOW)).toBe(true)
  })

  it('shows (fail-open) when dismissedDaemonCtaAt is malformed', () => {
    const settings = withStorage({
      dismissedDaemonCtaAt: 'not-a-date',
      dismissedDaemonCtaInstanceId: 'inst-1',
    })
    expect(shouldShowDaemonCta(settings, DETECTED, NOW)).toBe(true)
  })

  it('shows (fail-open) when dismissedDaemonCtaInstanceId is missing', () => {
    const settings = withStorage({ dismissedDaemonCtaAt: NOW.toISOString() })
    expect(shouldShowDaemonCta(settings, DETECTED, NOW)).toBe(true)
  })

  it('hides regardless of dismissal state when the probe is not-detected', () => {
    expect(shouldShowDaemonCta(defaultUserSettings(), NOT_DETECTED, NOW)).toBe(false)
    const dismissed = withStorage({
      dismissedDaemonCtaAt: NOW.toISOString(),
      dismissedDaemonCtaInstanceId: 'inst-1',
    })
    expect(shouldShowDaemonCta(dismissed, NOT_DETECTED, NOW)).toBe(false)
  })
})
