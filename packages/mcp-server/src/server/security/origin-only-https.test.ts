import { describe, expect, it } from 'vitest'
import { parseOriginPatternEntry } from './origin-pattern.js'
import { validateOriginEntry } from './origin-validation.js'
import { resolveServerModeExposure } from './server-mode-exposure.js'

// The origin-only https predicate has three callers (the neutral validator,
// the wildcard branch of the pattern parser, and the external URL check). They
// answer in different vocabularies, so the contract is that the same input is
// accepted by all or refused by all.
const SAMPLES: readonly string[] = [
  'https://example.com',
  'https://example.com/',
  'https://Example.COM:443',
  'https://example.com:8443',
  'http://example.com',
  'ftp://example.com',
  'not-a-url',
  'https://user:pass@example.com',
  'https://:pass@example.com',
  'https://example.com/path',
  'https://example.com?q=1',
  'https://example.com#frag',
]

const externalAccepts = (url: string): boolean => resolveServerModeExposure({ externalUrl: url }).ok

describe('origin-only https predicate', () => {
  it.each(SAMPLES)('the external URL check agrees with validateOriginEntry on %j', (sample) => {
    expect(externalAccepts(sample)).toBe(validateOriginEntry(sample).ok)
  })

  it('exposes the accepted samples in both, so the table reaches the accept side', () => {
    const accepted = SAMPLES.filter((sample) => validateOriginEntry(sample).ok)
    expect(accepted.length).toBeGreaterThanOrEqual(4)
    expect(SAMPLES.length - accepted.length).toBeGreaterThanOrEqual(6)
  })

  it('publishes the validator-normalised origin as the base URL', () => {
    const decision = resolveServerModeExposure({
      externalUrl: 'https://Example.COM:443/',
    })
    expect(decision.ok && decision.publicBaseUrl).toBe('https://example.com')
  })

  it.each(
    SAMPLES.filter((sample) => sample.startsWith('http')).map((sample) =>
      sample.replace('://', '://*.'),
    ),
  )('the wildcard branch refuses %j for the validator’s reason', (wildcardSample) => {
    const validated = validateOriginEntry(wildcardSample)
    const parsed = parseOriginPatternEntry(wildcardSample)
    if (validated.ok) {
      expect(parsed.ok).toBe(true)
    } else {
      expect(parsed).toEqual({ ok: false, reason: validated.reason })
    }
  })
})
