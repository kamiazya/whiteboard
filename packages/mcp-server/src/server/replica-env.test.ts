import { describe, expect, it } from 'vitest'
import {
  collectReplicaEnvIssues,
  parseReplicaLeaseTtlMs,
  parseReplicaTier,
  resolveReplicaEnv,
} from './replica-env.js'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

describe('parseReplicaTier', () => {
  it('defaults to offline when unset', () => {
    expect(parseReplicaTier({})).toEqual({ ok: true, value: 'offline' })
  })

  it('treats blank as unset', () => {
    expect(parseReplicaTier({ WHITEBOARD_REPLICA_TIER: '  ' })).toEqual({
      ok: true,
      value: 'offline',
    })
  })

  it('trims surrounding whitespace', () => {
    expect(parseReplicaTier({ WHITEBOARD_REPLICA_TIER: ' bounded ' })).toEqual({
      ok: true,
      value: 'bounded',
    })
  })

  it('accepts every declared tier', () => {
    for (const tier of ['no-offline', 'offline', 'bounded'] as const) {
      expect(parseReplicaTier({ WHITEBOARD_REPLICA_TIER: tier })).toEqual({ ok: true, value: tier })
    }
  })

  it('rejects an unknown tier, case-sensitively', () => {
    for (const raw of ['Offline', 'full-offline', 'nope']) {
      const parsed = parseReplicaTier({ WHITEBOARD_REPLICA_TIER: raw })
      expect(parsed.ok, `${raw} should be rejected`).toBe(false)
    }
  })
})

describe('parseReplicaLeaseTtlMs', () => {
  it('defaults to 7 days when unset', () => {
    expect(parseReplicaLeaseTtlMs({})).toEqual({ ok: true, value: SEVEN_DAYS_MS })
  })

  it('accepts a bare millisecond integer', () => {
    expect(parseReplicaLeaseTtlMs({ WHITEBOARD_REPLICA_LEASE_TTL_MS: '3600000' })).toEqual({
      ok: true,
      value: 3_600_000,
    })
  })

  it('rejects a unit suffix', () => {
    expect(parseReplicaLeaseTtlMs({ WHITEBOARD_REPLICA_LEASE_TTL_MS: '1h' }).ok).toBe(false)
  })
})

describe('resolveReplicaEnv', () => {
  it('resolves the defaults from an empty env', () => {
    expect(resolveReplicaEnv({})).toEqual({ tier: 'offline', leaseTtlMs: SEVEN_DAYS_MS })
  })

  it('resolves a fully configured env', () => {
    expect(
      resolveReplicaEnv({
        WHITEBOARD_REPLICA_TIER: 'no-offline',
        WHITEBOARD_REPLICA_LEASE_TTL_MS: '60000',
      }),
    ).toEqual({ tier: 'no-offline', leaseTtlMs: 60_000 })
  })
})

describe('collectReplicaEnvIssues', () => {
  it('reports nothing when unset', () => {
    expect(collectReplicaEnvIssues({})).toEqual([])
  })

  it('reports an invalid tier', () => {
    const issues = collectReplicaEnvIssues({ WHITEBOARD_REPLICA_TIER: 'Offline' })
    expect(issues.map((i) => i.variable)).toEqual(['WHITEBOARD_REPLICA_TIER'])
  })

  it('reports an invalid lease TTL', () => {
    const issues = collectReplicaEnvIssues({ WHITEBOARD_REPLICA_LEASE_TTL_MS: '1h' })
    expect(issues.map((i) => i.variable)).toEqual(['WHITEBOARD_REPLICA_LEASE_TTL_MS'])
  })

  it('reports both in one pass', () => {
    const issues = collectReplicaEnvIssues({
      WHITEBOARD_REPLICA_TIER: 'nope',
      WHITEBOARD_REPLICA_LEASE_TTL_MS: '1h',
    })
    expect(issues).toHaveLength(2)
  })
})
