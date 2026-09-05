// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { deriveCapabilityTier } from './capability-tier.js'
import type { DaemonProbeResult } from './daemon-probe.js'

describe('deriveCapabilityTier', () => {
  it('treats an http/loopback page origin as tier1-path-open when no probe has run', () => {
    expect(deriveCapabilityTier({ pageOriginScheme: 'http', probe: null })).toBe('tier1-path-open')
  })

  it('confirms tier1 on http origin once the probe detects a daemon', () => {
    const probe: DaemonProbeResult = { detected: true, instanceId: 'inst-1' }
    expect(deriveCapabilityTier({ pageOriginScheme: 'http', probe })).toBe('tier1-confirmed')
  })

  it('keeps tier1-path-open on http origin for a refused probe (scheme dominates)', () => {
    const probe: DaemonProbeResult = { detected: false, reason: 'refused' }
    expect(deriveCapabilityTier({ pageOriginScheme: 'http', probe })).toBe('tier1-path-open')
  })

  it('keeps tier1-path-open on http origin for a network-failed probe (scheme dominates)', () => {
    const probe: DaemonProbeResult = { detected: false, reason: 'network' }
    expect(deriveCapabilityTier({ pageOriginScheme: 'http', probe })).toBe('tier1-path-open')
  })

  it('confirms tier1 on https origin when the probe detects a daemon', () => {
    const probe: DaemonProbeResult = { detected: true, instanceId: 'inst-1' }
    expect(deriveCapabilityTier({ pageOriginScheme: 'https', probe })).toBe('tier1-confirmed')
  })

  it('confirms tier1 on https origin for an http-error reason (an HTTP response proves the path is open)', () => {
    const probe: DaemonProbeResult = { detected: false, reason: 'http-error' }
    expect(deriveCapabilityTier({ pageOriginScheme: 'https', probe })).toBe('tier1-confirmed')
  })

  it('confirms tier1 on https origin for a malformed reason (an HTTP response proves the path is open)', () => {
    const probe: DaemonProbeResult = { detected: false, reason: 'malformed' }
    expect(deriveCapabilityTier({ pageOriginScheme: 'https', probe })).toBe('tier1-confirmed')
  })

  it('reports tier1-path-open on https origin for a refused probe', () => {
    const probe: DaemonProbeResult = { detected: false, reason: 'refused' }
    expect(deriveCapabilityTier({ pageOriginScheme: 'https', probe })).toBe('tier1-path-open')
  })

  it('reports tier2-blocked on https origin for a proven-blocked probe', () => {
    const probe: DaemonProbeResult = { detected: false, reason: 'blocked' }
    expect(deriveCapabilityTier({ pageOriginScheme: 'https', probe })).toBe('tier2-blocked')
  })

  it('reports unknown on https origin for a timeout (not proven blocked)', () => {
    const probe: DaemonProbeResult = { detected: false, reason: 'timeout' }
    expect(deriveCapabilityTier({ pageOriginScheme: 'https', probe })).toBe('unknown')
  })

  it('reports unknown on https origin for an unclassified network failure', () => {
    const probe: DaemonProbeResult = { detected: false, reason: 'network' }
    expect(deriveCapabilityTier({ pageOriginScheme: 'https', probe })).toBe('unknown')
  })

  it('reports unknown on https origin when no probe has run yet', () => {
    expect(deriveCapabilityTier({ pageOriginScheme: 'https', probe: null })).toBe('unknown')
  })
})
